-- KEYS[1] key (portal+chatId)
-- KEYS[2] attackee
-- KEYS[3] attacker
--
-- ARGV[1] resonators
-- ARGV[2] mods
-- ARGV[3] links
-- ARGV[4] neutralized
--
-- RET[1] attackers
-- RET[2] resonators
-- RET[3] mods
-- RET[4] links
-- RET[5] neutralizez
-- RET[6] app data


local key = KEYS[1]
local attackee = KEYS[2]
local attacker = KEYS[3]

-- 60s TTL
local time = redis.call("time")[1] + 60


local counter = redis.call("hincrby", "clement", "counter", 1)
local appdata = redis.call("hget", key, "appdata")
redis.call("expireat", key, time)

redis.call("hincrby", key..".counters", "res:"..attackee, ARGV[1])
redis.call("hincrby", key..".counters", "mod:"..attackee, ARGV[2])
redis.call("hincrby", key..".counters", "lin:"..attackee, ARGV[3])
redis.call("hincrby", key..".counters", "neu:"..attackee, ARGV[4])
local counters = redis.call("hgetall", key..".counters")
redis.call("expireat", key..".counters", time)

local resonatorsMax = 0
local modsMax = 0
local linksMax = 0
local neutralizedMax = 0
for i=1,#counters,2 do
    local k = counters[i]
    local v = tonumber(counters[i + 1])
    if string.sub(k, 1, 4) == "res:" and v > resonatorsMax then
        resonatorsMax = v
    end
    if string.sub(k, 1, 4) == "mod:" and v > modsMax then
        modsMax = v
    end
    if string.sub(k, 1, 4) == "lin:" and v > linksMax then
        linksMax = v
    end
    if string.sub(k, 1, 4) == "neu:" and v > neutralizedMax then
        neutralizedMax = v
    end
end

redis.call("zincrby", key..".attackers", 1, attacker)
redis.call("expireat", key..".attackers", time)
local attackers = redis.call("zrevrange", key..".attackers", 0, -1) --, "WITHSCORES")

return {attackers, resonatorsMax, modsMax, linksMax, neutralizedMax, appdata}