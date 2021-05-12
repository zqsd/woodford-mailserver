import Redis from 'ioredis';
import express, { query } from 'express';
import {Telegraf} from 'telegraf';
import escape from 'escape-html';
import querystring from 'querystring';
import fetch from 'node-fetch';
import fs from 'fs';
import {db, ensureTransaction} from '../common/db.mjs';
import {subPortal, unsubPortal, unsubChat, migrateChat} from '../common/subscriptions.mjs';

const redis = new Redis({host: process.env.REDIS});

const defaultPortalImage = '/img/default-portal-image-200.png';

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
    try {
        return address.split(', ').slice(-2).join(', ');
    }
    catch(e) {
        return address;
    }
}

function reverse(latitude, longitude) {
    return fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`).then(res => res.json()).then((res) => {
        if(res.error) {
            return Object.assign({}, res.error, {
                lat: latitude,
                lon: longitude, 
            });
        }
        return res;
        //{"railway":"Léon Blum","road":"Place de Sparte","neighbourhood":"Antigone","suburb":"Centre","city":"Montpellier","municipality":"Montpellier","county":"Hérault","state":"Occitania","country":"France","postcode":"34064","country_code":"fr"}
        //{"building":"Gare de Montpellier Saint-Roch","road":"Rue des Deux Ponts","neighbourhood":"Gares","suburb":"Centre","city":"Montpellier","municipality":"Montpellier","county":"Hérault","state":"Occitania","country":"France","postcode":"34062","country_code":"fr"}
        //{"road":"Place Paul Vigné d'Octon","residential":"Résidence du 4 août 1789","suburb":"Port Marianne","city":"Montpellier","municipality":"Montpellier","county":"Hérault","state":"Occitania","country":"France","postcode":"34064","country_code":"fr"}
        //{"leisure":"Boulodrome des Patriotes","road":"Place des Patriotes","neighbourhood":"Port Marianne","suburb":"Port Marianne","city":"Montpellier","municipality":"Montpellier","county":"Hérault","state":"Occitania","country":"France","country_code":"fr"}
        //{"amenity":"Hôtel de Ville","house_number":"1","road":"Place Georges Frêche","neighbourhood":"Hameau de Moularès","suburb":"Prés d'Arènes","city":"Montpellier","municipality":"Montpellier","county":"Hérault","state":"Occitania","country":"France","country_code":"fr"}
        //{"suburb":"Cap d'Agde","town":"Agde","municipality":"Béziers","county":"Hérault","state":"Occitania","country":"France","postcode":"34300","country_code":"fr"}
        //{"tourism":"Tour Eiffel 2e étage","road":"Esplanade des Ouvriers de la Tour Eiffel","neighbourhood":"Quartier du Gros-Caillou","suburb":"7th Arrondissement","city":"Paris","municipality":"Paris","county":"Paris","state":"Ile-de-France","country":"France","postcode":"75007","country_code":"fr"}
    });
}

function nameFromReverse({address}) {
    if(address.tourism) {
        return address.tourism;
    }
    if(address.amenity) {
        return address.amenity;
    }
    if(address.leisure) {
        return address.leisure;
    }
    if(address.building) {
        return address.building;
    }
    if(address.residential) {
        return address.residential;
    }
    if(address.railway) {
        return address.railway;
    }
    if(address.road) {
        return address.road;
    }
    return 'Unknown location';
}

function addressFromReverse({latitude, longitude, address}) {
    if(address) {
        const names = [];

        const city = [];
        if(address.postcode) {
            city.push(address.postcode);
        }
        if(address.city) {
            city.push(address.city);
        }
        else if(address.town) {
            city.push(address.town);
        }
        else if(address.village) {
            city.push(address.village);
        }
        else if(address.municipality) {
            city.push(address.municipality);
        }
        names.push(city.join(' '));

        names.push(address.country);

        return names.join(', ');
    }
    else {
        return `${latitude},${longitude}`;
    }
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

function log(ctx) {
    console.log(ctx.chat);
    console.log(ctx.from);
    console.log(ctx.message);
    console.log('-');
}

bot.on('new_chat_participant', log);
bot.on('left_chat_participant', log);
bot.on('new_chat_title', log);
bot.on('group_chat_created', log);
bot.on('supergroup_chat_created', log);
bot.on('channel_chat_created', log);
bot.on(['migrate_to_chat_id', 'migrate_from_chat_id'], ctx => {
    return db.transaction(client => {
        if(ctx.message.migrate_from_chat_id) {
            return migrateChat(client, ctx.message.migrate_from_chat_id, ctx.chat.id);
        }
        else if(ctx.message.migrate_to_chat_id) {
            log(ctx);
        }
    });
});

bot.help((ctx) => ctx.reply('Send me a sticker'))

async function listSubscriptions(ctx, chatId) {
    bot.telegram.sendChatAction(chatId, `typing`);
    const portals = await db.all('SELECT p.* FROM portals_subscriptions AS ps INNER JOIN portals AS p ON p.id = ps.portal WHERE ps.chat = $1 ORDER BY name ASC', [chatId]);

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
    const image = `${process.env.URL}/portal/${ll}/image`;
    const ingress = 'https://ingress.com/launchapp';
    return `<a href="${portal.image}">&#8203;</a><a href="${image}">📍</a> <a href="${ingress}"><b>${escape(portal.name)}</b></a>
<a href="${maps}">🌍</a> <a href="${intel}">${escape(shortenAddress(portal.address))}</a>`;
}

async function createPortalAt(client, latE6, lngE6) {
    const rev = await reverse(latE6 / 1e6, lngE6 / 1e6);
    const name = nameFromReverse(rev);
    const address = addressFromReverse(rev);

    const portal = await client.one('INSERT INTO portals ("name", "address", "latE6", "lngE6") VALUES ($1, $2, $3, $4) RETURNING *', [
        name,
        address,
        latE6,
        lngE6,
    ]);
    return portal;
}

async function displayPortal(ctx, portalId, chatId, inlineMessageId) {
    let portal;
    if(portalId.startsWith('null:')) {
        const [latE6, lngE6] = portalId.split(':').slice(1).map(n => parseInt(n));
        portal = await createPortalAt(db, latE6, lngE6);
        portalId = portal.id;
    }
    else {
        portal = await db.one('SELECT portals.*, portals_subscriptions.portal AS subscribed FROM portals LEFT JOIN portals_subscriptions ON portals.id = portals_subscriptions.portal AND portals_subscriptions.chat = $2 WHERE portals.id = $1', [portalId, chatId]);
    }
    if(portal) {
        const text = portalText(portal);
        const extra = {
            parse_mode: 'html',
            reply_markup: {
                inline_keyboard: [
                    portal.subscribed ? [{ text: '🔕 Remove', callback_data: `portal.unsub:${portal.id}:${chatId}` }] : [{text: '🔔 Add', callback_data: `portal.sub:${portal.id}:${chatId}`}],
                    [{text: '⬅ Back to list', callback_data: `subs.list:${chatId}`}],
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
bot.command('unsuball', async (ctx) => {
    await db.transaction(async (client) => {
        bot.telegram.sendChatAction(ctx.chat.id, `typing`);
        await unsubChat(client, ctx.chat.id);
        ctx.reply(`All subscriptions from current chat removed`);
    });
});

const callbackQueryTable = {};

callbackQueryTable['subs.list'] = listSubscriptions;
callbackQueryTable['portal'] = async (ctx, portalId, chatId) => {
    await displayPortal(ctx, portalId, chatId);
    await ctx.answerCbQuery();
};

callbackQueryTable['portal.sub'] = async function(ctx, portalId, chatId) {
    await db.transaction(async client => {
        const portal = await client.one('SELECT * FROM portals WHERE id = $1', [portalId]);
        await subPortal(client, portal, chatId);
    });
    await displayPortal(ctx, portalId, chatId);
    await ctx.answerCbQuery(`Portal added to alerts`);
};

callbackQueryTable['portal.unsub'] = async function(ctx, portalId, chatId) {
    await db.transaction(async client => {
        const portal = await client.one('SELECT * FROM portals WHERE id = $1', [portalId]);
        await unsubPortal(client, portal, chatId);
    });
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
    let {inlineQuery: {query, location}} = ctx;
    let portals;
    let intelPortal;
    if(query.startsWith('https://intel.ingress.com/')) {
        const args = querystring.parse(query.substr(query.indexOf('?') + 1));
        if(args.pll) {
            const [latitude, longitude] = args.pll.split(',').map(parseFloat);
            location = {latitude, longitude};
            intelPortal = location;
            query = '';
        }
        else if(args.ll) {
            const [latitude, longitude] = args.pll.split(',').map(parseFloat);
            location = {latitude, longitude};
            query = '';
        }
    }

    if(location) {
        portals = await db.all(`SELECT DISTINCT id, name, address, image, "latE6", "lngE6", distance FROM (
            SELECT *, ST_Distance(geog, ST_SetSRID(ST_Makepoint($3, $4), 4326)::geography) AS distance FROM (
                (SELECT *, 0 AS score FROM portals WHERE lname LIKE $1 LIMIT ${MAX_RESULTS})
                UNION
                (SELECT *, 1 AS score FROM portals WHERE lname LIKE $2 LIMIT ${MAX_RESULTS})
            )
            ORDER BY score DESC, distance ASC LIMIT ${MAX_RESULTS}
        )`, [`%${query}`, `${query}%`, location.longitude, location.latitude]);
    }
    else {
        portals = await db.all(`SELECT DISTINCT id, name, address, image, "latE6", "lngE6" FROM (
            SELECT * FROM (
                (SELECT *, 0 AS score FROM portals WHERE lname LIKE $1 LIMIT ${MAX_RESULTS})
                UNION
                (SELECT *, 1 AS score FROM portals WHERE lname LIKE $2 LIMIT ${MAX_RESULTS})
            )
            ORDER BY score DESC LIMIT ${MAX_RESULTS}
        )`, [`%${query}`, `${query}%`]);
    }

    if(intelPortal) {
        const latE6 = Math.round(location.latitude * 1e6),
              lngE6 = Math.round(location.longitude * 1e6);
        const latitude = latE6 / 1e6,
              longitude = lngE6 / 1e6;
        // intel portal link matches no known portal
        if(portals.length > 0 && (latE6 !== parseInt(portals[0].latE6) || lngE6 !== parseInt(portals[0].lngE6)) || portals.length === 0) {
            const rev = await reverse(latitude, longitude);
            const name = nameFromReverse(rev);
            const address = addressFromReverse(rev);
            // create fake portal
            portals = [{
                id: `null:${latE6}:${lngE6}`,
                name,
                image: `${process.env.URL}${defaultPortalImage}`,
                address,
                latE6,
                lngE6,
            }].concat(portals);
        }
    }

    const results = portals.map(portal => {
        return {
            type: 'article',
            id: portal.id,
            title: portal.name || 'Unknown portal',
            thumb_url: portal.image || `${process.env.URL}${defaultPortalImage}`,
            description: portal.address + (portal.distance !== undefined ? '\n' + humanDistance(portal.distance) : ''),
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

/**
 * Redirects to portal full size image, or make a thumbnail for telegram since it won't make a thumbnail for bigger images
 */
function portalImageThumbnail(req, res, portal) {
    if(req.get('User-Agent') === 'TelegramBot (like TwitterBot)') {
        const ll = `${portal.latE6/1e6},${portal.lngE6/1e6}`;
        const url = portal.image ? `${portal.image}=s200` : `http://maps.googleapis.com/maps/api/staticmap?center=${ll}&zoom=17&size=267x200&style=visibility:on%7Csaturation:-50%7Cinvert_lightness:true%7Chue:0x131c1c&style=feature:water%7Cvisibility:on%7Chue:0x005eff%7Cinvert_lightness:true&style=feature:poi%7Cvisibility:off&style=feature:transit%7Cvisibility:off&markers=icon:http://commondatastorage.googleapis.com/ingress.com/img/map_icons/marker_images/neutral_icon.png%7Cshadow:false%7C${ll}&key=${process.env.MAPS_KEY}`;
        fetch(url).then(stream => {
            res.writeHead(200, {'Content-Type': stream.headers.get('content-type')});
            stream.body.on('end', () => res.end());
            stream.body.pipe(res);
        });
    }
    else {
        if(portal.image) {
            res.redirect(`${portal.image}=s0`);
        }
        else {
            res.redirect('https://commondatastorage.googleapis.com/ingress.com/img/default-portal-image.png');
        }
    }
}

app.get('/portal/:latitude,:longitude/image', async (req, res) => {
    const latE6 = Math.round(req.params.latitude * 1e6),
          lngE6 = Math.round(req.params.longitude * 1e6);
    const portal = await db.one('SELECT name, address, image, "latE6", "lngE6" FROM portals WHERE "latE6" = $1 AND "lngE6" = $2', [latE6, lngE6]);
    if(portal) {
        return portalImageThumbnail(req, res, portal);
    }
    else {
        res.sendStatus(404);
    }
});

app.get('/portal/:portalId/image', async (req, res) => {
    const portal = await db.one('SELECT name, address, image, "latE6", "lngE6" FROM portals WHERE id = $1', [req.params.portalId]);
    if(portal) {
        return portalImageThumbnail(req, res, portal);
    }
    else {
        res.sendStatus(404);
    }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`Example app listening on port ${port}!`)
    start_telegram();
});
