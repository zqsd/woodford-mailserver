import Redis from 'ioredis';
import {db, ensureTransaction} from '../common/db.mjs';

const redis = new Redis({host: process.env.REDIS});

function portalNameAddressKey(portal) {
    return `portal(na).subs:${portal.name, portal.address}`;
}

function portalLLKey(portal) {
    if(portal.latitude !== undefined && portal.longitude !== undefined) {
        return `portal(ll).subs:${portal.latitude},${portal.longitude}`;
    }
    else {
        return `portal(ll).subs:${portal.latE6 / 1e6},${portal.lngE6 / 1e6}`;
    }
}

export async function getAllSubscriptions(client) {
    return await ensureTransaction(client, async client => {
        return await client.all('SELECT p.name, p.address, p.image, p."latE6", p."lngE6", s.subscriptions FROM (SELECT portal, ARRAY_AGG(chat) as subscriptions FROM portals_subscriptions GROUP BY portal) AS s INNER JOIN portals as p ON p.id = s.portal');
    });
}

export async function syncAllSubscriptions(client) {
    let subscriptionsCount = 0;
    const subs = await getAllSubscriptions(client);
    for(const portal of subs) {
        const key = portalLLKey(portal);
        //console.log(key, portal.subscriptions);
        await redis.multi().del(key).sadd(key, portal.subscriptions).exec();
        subscriptionsCount += portal.subscriptions.length;
    }
    console.log(`loaded ${subscriptionsCount} subscriptions on ${subs.length} portals`);
    return subs;
}

export async function getPortalSubscriptions(portal) {
    const key = portalLLKey(portal);
    return await redis.smembers(key);
}

export async function subPortal(client, portal, chatId) {
    await client.query('INSERT INTO portals_subscriptions (portal, chat) VALUES ((SELECT id FROM portals WHERE "latE6" = $1 AND "lngE6" = $2), $3) ON CONFLICT (portal, chat) DO NOTHING', [portal.latE6, portal.lngE6, chatId]);
    await redis.sadd(portalLLKey(portal), chatId);
}

export async function unsubPortal(client, portal, chatId) {
    await client.query('DELETE FROM portals_subscriptions WHERE portal = (SELECT id FROM portals WHERE "latE6" = $1 AND "lngE6" = $2) AND chat = $3', [portal.latE6, portal.lngE6, chatId]);
    await redis.srem(portalLLKey(portal), chatId);
}

export async function unsubChat(client, chatId) {
    const {rows: subscriptions} = await client.query('SELECT * FROM portals WHERE id IN (SELECT portal FROM portals_subscriptions WHERE chat = $1)', [chatId]);
    await subscriptions.reduce((acc, portal) => {
        acc.srem(portalLLKey(portal), chatId);
    }, redis.multi()).exec();
    await client.query('DELETE FROM portals_subscriptions WHERE chat = $1', [chatId]);
}

export async function migrateChat(client, fromChatId, toChatId) {
    const {rows: subscriptions} = await client.query('SELECT * FROM portals WHERE id IN (SELECT portal FROM portals_subscriptions WHERE chat = $1)', [chatId]);
    await subscriptions.reduce((acc, portal) => {
        acc.srem(portalLLKey(portal), fromChatId);
        acc.sadd(portalLLKey(portal), toChatId);
    }, redis.multi()).exec();
    await client.query('UPDATE portals SET chat = $1 WHERE chat = $2', [toChatId, fromChatId]);
}
