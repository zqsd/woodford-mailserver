import Redis from 'ioredis';
import express, { query } from 'express';
import {Telegraf} from 'telegraf';
import escape from 'escape-html';
import pool from './db.mjs';

const redis = new Redis({host: process.env.REDIS});


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

const token = process.env.TELEGRAM_TOKEN;
if(token === undefined) {
    throw new Error('TELEGRAM_TOKEN must be provided!');
}

const bot = new Telegraf(token);

async function onChosenInlineResult(ctx) {
    // the ctx.chat.id is missing on chosen_inline_result event, so we store the inline_message_id and wait for a 'text' event
    let data;
    if(ctx.chosenInlineResult) {
        const portalId = ctx.chosenInlineResult.result_id;
        const key = `inlineResultLink:${portalId}`;
        ([, [, data]] = await redis.multi()
                   .hset(key, 'chosenInlineResult', JSON.stringify(ctx.chosenInlineResult))
                   .hgetall(key)
                   .expire(key, 10)
                   .exec());
    }
    else {
        const url = ctx.message.reply_markup?.inline_keyboard[0][0].url;
        const start = `https://telegram.me/${bot.botInfo.username}?startgroup=`;
        if(url?.startsWith(start)) {
            const portalId = url.substr(start.length);
            const key = `inlineResultLink:${portalId}`;
            ([, [, data]] = await redis.multi()
                    .hset(key, 'chat', JSON.stringify(ctx.chat))
                    .hgetall(key)
                    .expire(key, 10)
                    .exec());
        }        
    }
    if(data?.chat && data?.chosenInlineResult) {
        const chat = JSON.parse(data.chat);
        const chosenInlineResult = JSON.parse(data.chosenInlineResult);
        const portalId = chosenInlineResult.result_id;
        await displayPortal(ctx, portalId, chat.id, chosenInlineResult.inline_message_id);
    }
}

bot.on('text', async (ctx, next) => {
    // user clicked an inline query message
    if(ctx.message.via_bot?.id === bot.botInfo.id) {
        await onChosenInlineResult(ctx);
    }
    else {
        return await next();
    }
});

bot.on('chosen_inline_result', onChosenInlineResult);


bot.help((ctx) => ctx.reply('Send me a sticker'))

async function listSubscriptions(ctx, chatId) {
    const {rows: portals} = await pool.query('SELECT p.* FROM portals_subscriptions AS ps INNER JOIN portals AS p ON p.id = ps.portal WHERE ps.id = $1 ORDER BY name ASC', [chatId]);

    const text = portals.length > 0 ? 'Subscribed to portals :' : 'No subscribed portal';
    const extra = {
        reply_markup: {
            inline_keyboard: portals.map(portal => { return [{text: `📍 ${portal.name}`, callback_data: `portal:${portal.id}:${chatId}`}]})
                .concat([[{text: '➕ Search and add', switch_inline_query_current_chat: ''}]]),
        },
    };

    const inlineMessageId = ctx.callbackQuery?.inline_message_id;

    if(inlineMessageId) {
        await ctx.telegram.editMessageText(null, null, inlineMessageId, text, extra);
    }
    else if(ctx.callbackQuery) {
        await ctx.telegram.editMessageText(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id, null, text, extra);
        await ctx.answerCbQuery();
    }
    else {
        await ctx.reply(text, extra);
    }
}

function portalText(portal) {
    const ll = `${portal.latE6 / 1e6},${portal.lngE6 / 1e6}`;
    const intel = `https://intel.ingress.com/intel?z=17&pll=${ll}`;
    const maps = `https://www.google.com/maps?q=${ll}`;
    const image = `${process.env.URL}/portal/${portal.id}/image`;
    const ingress = 'https://ingress.com/launchapp';
    return `<a href="${portal.image}">&#8203;</a><a href="${image}">📍</a> <a href="${ingress}"><b>${escape(portal.name)}</b></a>
<a href="${maps}">🌍</a> <a href="${intel}">${escape(shortenAddress(portal.address))}</a>`;
}

async function displayPortal(ctx, portalId, chatId, inlineMessageId) {
    const {rows: [portal]} = await pool.query('SELECT portals.*, portals_subscriptions.portal AS subscribed FROM portals LEFT JOIN portals_subscriptions ON portals.id = portals_subscriptions.portal AND portals_subscriptions.id = $2 WHERE portals.id = $1', [portalId, chatId]);
    if(portal) {
        const text = portalText(portal);
        const extra = {
            parse_mode: 'html',
            reply_markup: {
                inline_keyboard: [
                    portal.subscribed ? [{ text: '🔕 Remove', callback_data: `portal.unsub:${portal.id}:${chatId}` }] : [{text: '🔔 Add', callback_data: `portal.sub:${portal.id}:${chatId}`}],
                    [{text: '⮨ Back to list', callback_data: `subs.list:${chatId}`}],
                ],
            },
        };

        if(ctx.callbackQuery?.inline_message_id)
            inlineMessageId = ctx.callbackQuery.inline_message_id;

        if(inlineMessageId) {
            await ctx.telegram.editMessageText(null, null, inlineMessageId, text, extra);
        }
        else if(ctx.callbackQuery) {
            await ctx.telegram.editMessageText(chatId, ctx.callbackQuery.message.message_id, null, text, extra);
        }
        else {
            await ctx.telegram.editMessageText(chatId, ctx.message.message_id, null, text, extra);
        }
    }
}

bot.command('subs', (ctx) => listSubscriptions(ctx, ctx.chat.id));

const callbackQueryTable = {};

callbackQueryTable['subs.list'] = listSubscriptions;
callbackQueryTable['portal'] = async (ctx, portalId, chatId) => {
    await displayPortal(ctx, portalId, chatId);
    await ctx.answerCbQuery();
};

callbackQueryTable['portal.sub'] = async function(ctx, portalId, chatId) {
    await pool.query('INSERT INTO portals_subscriptions (portal, id) VALUES ($1, $2) ON CONFLICT (portal, id) DO NOTHING', [portalId, chatId]);
    await displayPortal(ctx, portalId, chatId);
    await ctx.answerCbQuery(`Portal added to alerts`);
};

callbackQueryTable['portal.unsub'] = async function(ctx, portalId, chatId) {
    await pool.query('DELETE FROM portals_subscriptions WHERE portal = $1 AND id = $2', [portalId, chatId]);
    await displayPortal(ctx, portalId, chatId);
    await ctx.answerCbQuery(`Portal removed from alerts`);
};

bot.on('callback_query', (ctx) => {
    const [cmd, ...args] = ctx.callbackQuery.data.split(':');
    if(cmd in callbackQueryTable) {
        callbackQueryTable[cmd](ctx, ...args);
    }
})

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
        return {
            type: 'article',
            id: portal.id,
            title: portal.name || 'Unknown portal',
            thumb_url: portal.image || `${process.env.URL}/img/default-portal-image-512.png`,
            description: shortenAddress(portal.address) + (portal.distance !== undefined ? '\n' + humanDistance(portal.distance) : ''),
            input_message_content: {
                message_text: portalText(portal),
                parse_mode: 'html',
            },
            reply_markup: {
                inline_keyboard: [
                    [{text: 'Invite bot here to enable alerts', url: `https://telegram.me/${bot.botInfo.username}?startgroup=${portal.id}`}],
                ],
            },
        };
    });
    return await ctx.answerInlineQuery(results, {
        is_personal: true,
        cache_time: 0,
    });
});

async function start_telegram() {
    const url = process.env.URL || process.env.LT_URL;
    if(url === undefined) {
        throw new Error('URL must be provided!');
    }
    const [me] = await Promise.all([
        bot.telegram.getMe(),
        bot.telegram.setWebhook(url + process.env.TELEGRAM_ENDPOINT),
    ]);
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