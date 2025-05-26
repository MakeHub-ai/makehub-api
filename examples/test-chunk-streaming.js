import http from 'http';

const API_KEY = process.env.TEST_API_KEY || 'test-api-key-123';

const options = {
  hostname: 'localhost',
  port: 3000, // Assuming your API gateway runs on port 3000
  path: '/v1/chat/completions', // Adjust if your streaming endpoint is different
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
  }
};

const postData = JSON.stringify({
  model: 'gpt-4o', // Or any model that supports streaming
  messages: [{ role: 'user', content: 'Tell me a short story about a brave cat.' }],
  stream: true
});

console.log('Starting request to check chunk streaming...');

let requestSentTime; // To store when the request is actually sent

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
  res.setEncoding('utf8');

  let chunkCount = 0;
  let firstDataEventTime = null;
  let previousChunkTime = null;

  res.on('data', (chunk) => {
    const currentTime = Date.now();
    if (!firstDataEventTime) {
      firstDataEventTime = currentTime;
      previousChunkTime = firstDataEventTime; // Initialize for the first chunk's "time since last"
      const timeToFirstData = firstDataEventTime - requestSentTime;
      console.log(`Time to first data event: ${timeToFirstData}ms`);
    }
    const timeDifference = currentTime - previousChunkTime;
    chunkCount++;
    console.log(`-------------------------`);
    console.log(`CHUNK ${chunkCount} RECEIVED`);
    console.log(`Time since last chunk: ${timeDifference}ms`);
    console.log(`Raw chunk: ${chunk.trim()}`);
    console.log(`-------------------------`);
    previousChunkTime = currentTime;
  });

  res.on('end', () => {
    console.log('No more data in response.');
    console.log(`Total chunks received: ${chunkCount}`);
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

// Write data to request body
req.write(postData);
requestSentTime = Date.now(); // Record time just before sending
req.end();
