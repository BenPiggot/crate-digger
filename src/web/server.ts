import Fastify, { type FastifyError } from 'fastify';
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises";

import { CrateDigger, InvalidInputError } from "../core/service.js";
import { settingsFromEnv } from '../core/config.js';
import { DiscogsError } from '../core/discogs.js';

const INDEX = fileURLToPath(new URL("../../static/index.html", import.meta.url));

const releasesSchema = {
    querystring: {
        type: 'object', 
        properties: {
            q: { type: 'string' },
            catno: { type: 'string' },
            barcode: { type: 'string' }
        }
    }
};

const copiesSchema = {
    type: 'object',
    params: {
        type: 'object',
        properties: {
            release_id: { type: "integer" }
        }
    },
    querystring: {
        type: 'object',
        properties: {
            sellers: { type: 'string' },
            max_price: { type: 'number' },
            refresh: { type: 'boolean', default: false },
            with_details: { type: 'boolean', default: true }
        }
    }
};

export function createApp(crateDigger = new CrateDigger(settingsFromEnv(process.env, { loadDotenv: true }))) {
    const app = Fastify({
        logger: true
    })

    app.get('/', async (_request, reply) => {
        const html = await readFile(INDEX, 'utf8');
        return reply.type('text/html').send(html);
    });

    app.get<{ Querystring: { q?: string; catno?: string; barcode?: string } }>('/api/releases', 
        { schema: releasesSchema },
        async (request) => {
            const { q, catno, barcode } = request.query;
            return await crateDigger.searchReleases(q ?? "", { catno, barcode });
        }
    );

    app.get('/api/config', async (_request) => {
        const d = crateDigger;
        return await Promise.resolve({ 
            default_sellers: Array.isArray(d.settings.discogsSellers ?? []) ? d.settings.discogsSellers : [] 
        });
    });

    app.get<{ Params: { release_id: number }; Querystring: { sellers?: string; max_price?: number; refresh?: boolean; with_details?: boolean } }>('/api/releases/:release_id/copies',
        { schema: copiesSchema },
        async (_request) => {
        const { release_id } = _request.params;
        const { sellers, refresh, max_price, with_details } = _request.query;

        const sellerList = sellers?.length ? sellers.split(",")
            .map(s => s.trim()).filter(s => s.length > 0) : undefined;

        return await crateDigger.findCopies(release_id, { sellers: sellerList,
            refresh: refresh ?? false,
            maxPrice: max_price ?? null,
            withDetails: with_details ?? false }
        );
    });

    app.setErrorHandler<FastifyError>((error, _request, reply) => {
        if (error instanceof DiscogsError || error instanceof InvalidInputError) {
            return reply.status(400).send({ detail: error.message });
        }
        return reply.status(error.statusCode ?? 500).send({ detail: error.message });
    });

    return app;
}
