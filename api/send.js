export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', error: 'Only POST requests allowed.' });
  }

  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ status: 'error', error: 'Missing message content' });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });

    const result = await response.json();

    if (!response.ok) {
      return res.status(500).json({ status: 'error', error: result.description || 'Telegram error' });
    }

    return res.status(200).json({ status: 'ok', telegram: result });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
}
