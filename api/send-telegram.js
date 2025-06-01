const fetch = require('node-fetch');

const TOKEN = '7509433067:AAGoLc1NVWqmgKGcrRVb3DwMh1o5_v5Fyio';
const CHAT_ID = '8047420957';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { message } = req.body;

  try {
    const telegramRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message })
    });

    const result = await telegramRes.json();
    res.status(200).json({ status: 'ok', result });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
};
