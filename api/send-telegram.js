import fetch from 'node-fetch';

const TOKEN = '你的TOKEN';
const CHAT_ID = '你的CHAT_ID';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { message } = req.body;

  try {
    const response = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
    });

    const result = await response.json();
    res.status(200).json({ status: 'ok', result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
}
