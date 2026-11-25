import { createApp } from '../web/server.js';

const app = createApp();

try {
    await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 8000) });
} 
catch (err) {
    app.log.error(err)
    process.exit(1)
}   

export default app;