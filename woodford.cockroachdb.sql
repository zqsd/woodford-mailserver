CREATE TYPE team AS ENUM ('neutral', 'resistance', 'enlightened');

CREATE TABLE portals (
	"id" UUID NOT NULL DEFAULT gen_random_uuid(),
	"name" STRING,
	"address" STRING,
	"lname" STRING AS (lower("name")) STORED
	"image" STRING NULL,
	"latE6" INT NOT NULL CHECK ("latE6" >= -90e6) CHECK ("latE6" <= 90e6),
	"lngE6" INT NOT NULL CHECK ("lngE6" >= -180e6) CHECK ("lngE6" <= 180e6),
	"geog" GEOGRAPHY(GEOMETRY, 4326) NOT NULL AS (ST_SetSRID(ST_Makepoint("lngE6"::FLOAT / 1e6, "latE6"::FLOAT / 1e6), 4326)::geography) STORED,
	"lastAlert" TIMESTAMPTZ NULL,

	--"creator" UUID NULL,
	CONSTRAINT "primary" PRIMARY KEY (id ASC),
	INDEX latlng_idx ("latE6" ASC, "lngE6" ASC),
	INDEX name_idx ("name" ASC),
	INVERTED INDEX geog_idx ("geog"),
	INDEX "lastAlert_idx" ("lastAlert" DESC),
	UNIQUE INDEX portals_name_address ("name" ASC, "address" ASC),
    FAMILY f1("id", "name", "address", "image", "lastAlert"),
    FAMILY f2("latE6", "lngE6", "geog")
);

CREATE TABLE portals_subscriptions(
    "portal" UUID,
    "id" INT NOT NULL, -- telegram chat id

    CONSTRAINT "primary" PRIMARY KEY ("portal", "id"),
    INDEX "chatid_idx" ("id" ASC)
) INTERLEAVE IN PARENT portals("portal");

--CREATE TABLE portals_damages(
--    "portal" UUID,
--    "timestamp" TIMESTAMPTZ NOT NULL,
--    "team" TEAM NOT NULL,
--    "resonators" INT NOT NULL DEFAULT 0 CHECK ("resonators" >= 0) CHECK ("resonators" <= 8),
--    "mods" INT NOT NULL DEFAULT 0 CHECK ("mods" >= 0) CHECK ("mods" <= 4),
--    "links" INT NOT NULL DEFAULT 0 CHECK ("links" >= 0),
--    "neutralization" BOOL NOT NULL,
--    "attackee" UUID NOT NULL,
--    CONSTRAINT "primary" PRIMARY KEY ("portal", "timestamp")
--) INTERLEAVE IN PARENT portals("portal");
