const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

(async () => {
  const testImage = process.argv[2] || './test.png';
  const url = 'http://127.0.0.1:8000/ocr/upload';

  console.log('--- curl (via child_process) ---');
  await new Promise((resolve) => {
    const curl = spawn('curl', ['-sS', '-v', '-X', 'POST', url, '-F', `file=@${testImage}`]);
    curl.stdout.on('data', chunk => process.stdout.write(chunk));
    curl.stderr.on('data', chunk => process.stderr.write(chunk));
    curl.on('close', (code) => {
      console.log(`\ncurl exited with code ${code}`);
      resolve();
    });
  });

  console.log('\n--- axios FormData ---');
  const form = new FormData();
  form.append('file', fs.createReadStream(testImage));
  const headers = form.getHeaders();
  headers['Accept'] = '*/*';
  headers['User-Agent'] = 'axios-test';

  try {
    const res = await axios.post(url, form, {
      headers,
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      proxy: false,
      httpsAgent: false,
      validateStatus: () => true,
      onUploadProgress: (evt) => {
        if (evt.loaded && evt.total) {
          const percent = ((evt.loaded / evt.total) * 100).toFixed(2);
          process.stdout.write(`\rUploaded ${evt.loaded}/${evt.total} (${percent}%)`);
        } else {
          process.stdout.write(`\rUploaded ${evt.loaded || 0} bytes`);
        }
      }
    });

    console.log('\nstatus:', res.status);
    console.log('headers:', res.headers);
    console.log('body preview:', JSON.stringify(res.data).slice(0, 400));
  } catch (err) {
    console.error('axios error:', err.code || err.message);
    if (err.response) {
      console.error('status:', err.response.status);
      console.error('body:', err.response.data);
    }
  }
})();
