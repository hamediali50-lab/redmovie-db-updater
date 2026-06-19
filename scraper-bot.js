const axios = require('axios');
const { MongoClient } = require('mongodb');

const API_BASE_URL = 'https://cinemaplus-app.vercel.app';
const MONGO_URI = process.env.MONGO_URI; 

if (!MONGO_URI) {
    console.error("❌ Error: MONGO_URI is missing!");
    process.exit(1);
}

const CONCURRENCY_LIMIT = 15; 

const TARGET_ENDPOINTS = [
    { url: '/api/movies/new', type: 'movie', name: 'سینمایی جدید', forceUpdate: false },
    { url: '/api/movies/top-rated', type: 'movie', name: 'سینمایی برتر', forceUpdate: false },
    { url: '/api/series/new', type: 'series', name: 'سریال جدید', forceUpdate: false },
    { url: '/api/series/updated', type: 'series', name: 'سریال آپدیت شده', forceUpdate: true },
    { url: '/api/series/top-rated', type: 'series', name: 'سریال برتر', forceUpdate: false }
];

const client = axios.create({
    baseURL: API_BASE_URL,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
});

async function fetchSeasons(seriesId) {
    try { const { data } = await client.get(`/api/seasons/${seriesId}`); return data; } catch (error) { return null; }
}

async function processAndSaveItems(items, config, collection) {
    let addedCount = 0;
    let updatedCount = 0;

    const seriesItems = items.filter(item => config.type === 'series');
    if (seriesItems.length > 0) {
        for (let i = 0; i < seriesItems.length; i += CONCURRENCY_LIMIT) {
            const batch = seriesItems.slice(i, i + CONCURRENCY_LIMIT);
            await Promise.all(batch.map(async (seriesItem) => {
                const seasonData = await fetchSeasons(seriesItem.id);
                if (seasonData) seriesItem.seasons = seasonData;
            }));
        }
    }

    for (const item of items) {
        const myId = `plus_${item.id}`;
        const cleanItem = {
            id: myId, real_id: item.id, title: item.title, image: item.image, year: item.year, imdb: item.imdb,
            description: item.description, itemType: config.type, sources: item.sources || [], seasons: item.seasons || null 
        };

        const existingItem = await collection.findOne({ id: myId });

        if (!existingItem) {
            await collection.insertOne(cleanItem);
            console.log(`   ✅ Added: ${cleanItem.title}`);
            addedCount++;
        } else if (config.forceUpdate) {
            await collection.updateOne({ id: myId }, { $set: cleanItem });
            console.log(`   🔄 Updated: ${cleanItem.title}`);
            updatedCount++;
        }
    }
    return { addedCount, updatedCount };
}

async function main() {
    console.log("🚀 Scraper Bot Started...");
    let mongoClient;

    try {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        const db = mongoClient.db('RedMovie');
        const collection = db.collection('movies');
        console.log("✅ MongoDB Connected.");

        for (const endpoint of TARGET_ENDPOINTS) {
            console.log(`\n🌐 Checking: ${endpoint.name}`);
            
            for (let page = 0; page < 5; page++) {
                try {
                    const { data } = await client.get(`${endpoint.url}?page=${page}`);
                    const results = data.posters || data.search_results || data;
                    if (!results || results.length === 0) break;
                    
                    const { addedCount, updatedCount } = await processAndSaveItems(results, endpoint, collection);
                    
                    if (addedCount === 0 && updatedCount === 0 && !endpoint.forceUpdate) {
                        console.log(`   No new items on page ${page + 1}. Skipping rest.`);
                        break; 
                    }
                } catch (error) { 
                    console.error(`❌ Error on page ${page + 1}:`, error.message);
                    break; 
                }
            }
        }
        console.log("\n🎉 Process Finished Successfully.");
    } catch (error) {
        console.error("❌ Global Error:", error.message);
    } finally {
        if (mongoClient) await mongoClient.close();
    }
}

main();
