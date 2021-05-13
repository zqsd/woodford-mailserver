import express from 'express';
import {expressMiddleware} from './telegram.mjs';

const app = express();
/*app.use(function(req, res, next) {
    console.log("GOT REQUEST !");
    next(); // Passing the request to the next handler in the stack.
});*/

app.use(expressMiddleware);
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

export default function() {
    const port = process.env.PORT || 8080;
    app.listen(port, () => {
        console.log(`Listening on port ${port}!`)
    });
}