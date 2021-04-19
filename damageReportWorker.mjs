import Redis from 'ioredis';
import db from './db.mjs';
import {Telegraf} from 'telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN)
const redis = new Redis();

function portalNameAddressKey(portal) {
    return `portal(na).subs:${portal.name, portal.address}`;
}

async function fetchSubscriptions() {
    await db.transaction(async client => {
        let subscriptionsCount = 0;
        const dbSubcriptions = await client.query('SELECT p.name, p.address, p.image, p."latE6", p."lngE6", s.subscriptions FROM (SELECT portal, ARRAY_AGG(id) as subscriptions FROM portals_subscriptions GROUP BY portal) AS s INNER JOIN portals as p ON p.id = s.portal');
        for(const portal of dbSubcriptions.rows) {
            const key = portalNameAddressKey(portal);
            await redis.multi().del(key).sadd(key, portal.subscriptions).exec();
            subscriptionsCount += portal.subscriptions.length;
        }
        console.log(`loaded ${subscriptionsCount} subscriptions on ${dbSubcriptions.rows.length} portals`);
    });

}
fetchSubscriptions();

async function sendPortalAlert(chatId, portal, damage, agent) {
    try {
        const city = portal.address.split(', ').slice(-2, -1).join('').split(' ').slice(1);
        const pll = `${portal.latitude},${portal.longitude}`;
        const text = `<a href="${portal.image}">&#8203;</a><a href="https://www.ingress.com/intel?z=17&pll=${pll}"><b>${portal.name}</b></a> @ <a href="https://www.google.com/maps?q=${pll}">${city}</a>
attacked by <b>${agent.name}</b>`;
        await bot.telegram.sendMessage(chatId, text, {
            parse_mode: 'HTML',
        });
    }
    catch(e) {
        if(e.message === '400: Bad Request: chat not found') {
            await Promise.all([
                redis.spop(portalNameAddressKey(portal), chatId),
                db.query('DELETE FROM portals_subscriptions WHERE id = $3 AND portal = (SELECT id FROM portals WHERE name = $1 AND address = $2)', [portal.name, portal.address, chatId]),
            ]);
            console.log(`removed portal ${portal.name} from chat ${chatId}`);
        }
        else {
            throw e;
        }
    }
}

export default function pushDamagesFromReport(report) {
    return Promise.all(report.damages.map(async damage => {
        const portal = report.portals[damage.portal];
        const attacker = report.agents[damage.attacker];
        const subscriptions = await redis.smembers(portalNameAddressKey(portal));

        console.log(`attack on ${portal.name} by ${attacker.name}`);
        //console.log(report.damages);

        return Promise.all(subscriptions.map(subscription => {
            return sendPortalAlert(subscription, portal, damage, attacker);
        }));
    }));
}