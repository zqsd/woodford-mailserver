import Redis from 'ioredis';
import {db, ensureTransaction} from '../common/db.mjs';
import {Telegraf} from 'telegraf';
import Redlock from 'redlock';
import fs from 'fs';
import {syncAllSubscriptions} from '../common/subscriptions.mjs';

const redis = new Redis({host: process.env.REDIS});
const redlock = new Redlock([redis]);

const bot = new Telegraf(process.env.BOT_TOKEN)

redis.defineCommand("portalCountDamage", {
    numberOfKeys: 3,
    lua: fs.readFileSync('./damage.lua'),
});

syncAllSubscriptions();

async function sendPortalAlert(chatId, portal, damage, attacker, report) {
    const key = `portal(${portal.latitude},${portal.longitude}),${chatId}`;
    const lock = await redlock.lock(key+'.lock', 1000);
    const [attackers, resonatorsDestroyed, modsDestroyed, linksDestroyed, neutralized, cachedDataJson] = await redis.portalCountDamage(key, report.attackee, attacker.name, damage.resonators, damage.mods, damage.links.length, portal.team === 'neutralized' ? 1 : 0);
    const cachedData = JSON.parse(cachedDataJson);

    // check if message changed
    const hash = `${Math.min(resonatorsDestroyed, 9)},${modsDestroyed},${linksDestroyed},${neutralized},${attackers.join(',')}`;

    if(!cachedData || cachedData.hash !== hash) {
        const city = portal.address.split(', ').slice(-2, -1).join('').split(' ').slice(1);
        const pll = `${portal.latitude},${portal.longitude}`;
        const intel = `https://intel.ingress.com/intel?z=17&pll=${pll}`;
        const ingress = `https://ingress.com/launchapp`;    
        const maps = `https://www.google.com/maps?q=${pll}`;

        let text = `<a href="${portal.image}">&#8203;</a><a href="${ingress}"><b>${portal.name}</b></a> @ <a href="${intel}">${city}</a>
attacked by ` + attackers.map(attacker => `<b>${attacker}</b>`).join(', ');

        const destructions = [];
        if(resonatorsDestroyed >= 9) {
            destructions.push('<b>8+</b> resonators');
        }
        else if(resonatorsDestroyed > 0) {
            destructions.push(`<b>${resonatorsDestroyed}</b> resonator${resonatorsDestroyed != 1 ? 's' : ''}`);
        }
        if (modsDestroyed > 0) {
            destructions.push(`<b>${modsDestroyed}</b> mod${modsDestroyed != 1 ? 's' : ''}`);
        }
        if(linksDestroyed > 0) {
            destructions.push(`<b>${linksDestroyed}</b> mod${linksDestroyed != 1 ? 's' : ''}`);
        }
        if(destructions.length > 0) {
            text += '\n' + destructions.join(', ') + ' destroyed';
        }

        
        if(neutralized == 1) {
            text += `\nneutralized`;
        }
        else if(neutralized > 1) {
            text += `\nneutralized <b>${neutralized}</b> time${neutralized > 1 ? 's' : ''}`;
        }

        try {
            if(cachedData?.messageId) {
                try {
                    await bot.telegram.editMessageText(chatId, cachedData.messageId, null, text, {
                        parse_mode: 'HTML',
                    });
                }
                catch(e) {console.error(e.message);}
                await redis.hset(key, 'appdata', JSON.stringify({
                    messageId: cachedData.messageId,
                    hash,
                }));
            }
            else {
                const result = await bot.telegram.sendMessage(chatId, text, {
                    parse_mode: 'HTML',
                });
                await redis.hset(key, 'appdata', JSON.stringify({
                    messageId: result.message_id,
                    hash,
                }));
            }
        }
        catch(e) {
            if(e.message === '400: Bad Request: chat not found') {
                await unsubChat(db, chatId);
                console.log(`chat ${chatId} not found, removed froms subscription`);
            }
            else {
                throw e;
            }
        }
    }
    await lock.unlock();
}

export default function pushDamagesFromReport(report) {
    return Promise.all(report.damages.map(async damage => {
        const portal = report.portals[damage.portal];
        const attacker = report.agents[damage.attacker];
        const subscriptions = getPortalSubscriptions(portal);

        const damages = [];
        if(damage.resonators > 0) {
            damages.push(`${damage.resonators} resonators`);
        }
        if(damage.mods > 0) {
            damages.push(`${damage.mods} mods`);
        }
        if(damage.links?.length > 0) {
            damages.push(`${damage.links.length} links`);
        }
        console.log(`damage on ${portal.name} by ${attacker.name}: ${damages.join(', ')}`);
        //console.log(report.damages);

        return Promise.all(subscriptions.map(subscription => {
            return sendPortalAlert(subscription, portal, damage, attacker, report);
        }));
    }));
}
