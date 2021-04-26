import express from 'express';
import {Telegraf} from 'telegraf';
import escape from 'escape-html';
import pool from './db.mjs';


function humanDistance(distance) {
    if(distance < 1000) {
        return Math.round(distance) + ' m';
    }
    else if(distance < 10000) {
        return Math.round(distance / 100) / 10 + ' km';
    }
    else {
        return Math.round(distance / 1000) + ' km';
    }
}

function shortenAddress(address) {
    return address.split(', ').slice(-2).join(', ');
}

(async () => {
    const token = process.env.TELEGRAM_TOKEN;
    if(token === undefined) {
        throw new Error('TELEGRAM_TOKEN must be provided!');
    }

    const bot = new Telegraf(token);
    //bot.on('text', (ctx) => ctx.replyWithHTML('<b>Hello</b>'));
    bot.help((ctx) => ctx.reply('Send me a sticker'))

    bot.command('subs', async (ctx) => {
        const {rows: portals} = await pool.query('SELECT p.* FROM portals_subscriptions AS ps INNER JOIN portals AS p ON p.id = ps.portal WHERE ps.id = $1 ORDER BY name ASC', [ctx.chat.id]);
        ctx.reply(JSON.stringify(portals, null, 4));
    });

    bot.on('inline_query', async (ctx) => {
        const MAX_RESULTS = 10;
        const {inlineQuery: {query, location}} = ctx;
        let portals;
        if(location) {
            ({rows: portals} = await pool.query(`SELECT DISTINCT id, name, address, image, "latE6", "lngE6", distance FROM (
                SELECT *, ST_Distance(geog, ST_SetSRID(ST_Makepoint($3, $4), 4326)::geography) AS distance FROM (
                    (SELECT *, 0 AS score FROM portals WHERE lname LIKE $1 LIMIT ${MAX_RESULTS})
                    UNION
                    (SELECT *, 1 AS score FROM portals WHERE lname LIKE $2 LIMIT ${MAX_RESULTS})
                )
                ORDER BY score DESC, distance ASC LIMIT ${MAX_RESULTS}
            )`, [`%${query}`, `${query}%`, location.longitude, location.latitude]));
        }
        else {
            ({rows: portals} = await pool.query(`SELECT DISTINCT id, name, address, image, "latE6", "lngE6" FROM (
                SELECT * FROM (
                    (SELECT *, 0 AS score FROM portals WHERE lname LIKE $1 LIMIT ${MAX_RESULTS})
                    UNION
                    (SELECT *, 1 AS score FROM portals WHERE lname LIKE $2 LIMIT ${MAX_RESULTS})
                )
                ORDER BY score DESC LIMIT ${MAX_RESULTS}
            )`, [`%${query}`, `${query}%`]));
        }
        const results = portals.map(portal => {
            const ll = `${portal.latE6 / 1e6},${portal.lngE6 / 1e6}`;
            const intel = `https://intel.ingress.com/intel?z=17&pll=${ll}`;
            const maps = `https://www.google.com/maps?q=${ll}`;
            const image = `${process.env.URL}/portal/${portal.id}/image`;
            const ingress = 'https://ingress.com/launchapp';
            return {
                type: 'article',
                id: portal.id,
                title: portal.name || 'Unknown portal',
                thumb_url: portal.image || `${process.env.URL}/img/default-portal-image-512.png`,
                description: shortenAddress(portal.address) + (portal.distance !== undefined ? '\n' + humanDistance(portal.distance) : ''),
                input_message_content: {
                    message_text: `<a href="${portal.image}">&#8203;</a><a href="${image}">📍</a> <a href="${ingress}"><b>${escape(portal.name)}</b></a>
<a href="${intel}">${escape(shortenAddress(portal.address))}</a> <a href="${maps}">🗺️</a>`,
                    parse_mode: 'html',
                },
                reply_markup: {
                    inline_keyboard: [
                        [{text: 'Subscribe', callback_data: `portal.sub:${portal.id}`}],
                    ],
                },
            };
        });
        await ctx.answerInlineQuery(results, {
            is_personal: true,
            cache_time: 0,
        });
    });

    async function start_telegram() {
        const url = process.env.URL || process.env.LT_URL;
        if(url === undefined) {
              console.log(bot.telegram.botInfo);
              throw new Error('URL must be provided!');
        }
        const [me] = await Promise.all([
            bot.telegram.getMe(),
            bot.telegram.setWebhook(url + process.env.TELEGRAM_ENDPOINT),
        ]);
        console.log(url + process.env.TELEGRAM_ENDPOINT);
        if(!me.supports_inline_queries) {
            throw new Error('telegram bot must support inline queries');
        }
        if(!me.can_join_groups) {
            throw new Error('telegram bot must be enabled to join groups');
        }
        //console.log(me);
    }


    const app = express();
    /*app.use(function(req, res, next) {
        console.log("GOT REQUEST !");
        next(); // Passing the request to the next handler in the stack.
    });*/

    app.use(bot.webhookCallback(process.env.TELEGRAM_ENDPOINT));
    //app.get('/', (req, res) => res.send('Hello World!'));

    app.get('/portal/:portalId/image', async (req, res) => {
        const {rows: [{image}]} = await pool.query('SELECT image FROM portals WHERE id = $1', [req.params.portalId]);
        if(image) {
            if(req.get('User-Agent') === 'TelegramBot (like TwitterBot)') {
                res.redirect(image);
            }
            else {
                res.redirect(image + '=s0');
            }
        }
        else {
            res.redirect('/img/default-portal-image-512.png');
        }
    });

    const port = process.env.PORT || 8080;
    app.listen(port, () => {
        console.log(`Example app listening on port ${port}!`)
        start_telegram();
    });
})();
