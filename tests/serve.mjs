// Локальный запуск приложения: npm start → http://127.0.0.1:<порт>/ (localhost считается безопасным: микрофон работает).
import { startServer } from './lib.mjs';

const { base } = await startServer(+process.env.PORT || 8080);
console.log(`Помощник по учёбе: ${base}`);
