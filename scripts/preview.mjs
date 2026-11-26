import path from 'node:path';
import { startServer, ROOT } from '../tests/lib.mjs';

const { base } = await startServer(Number(process.env.PORT) || 8081, path.join(ROOT, 'dist'), '/helper-with-conspects/');
console.log('Preview: ' + base);
