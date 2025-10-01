-- Example: Creating a Discord Source
-- Replace the placeholder values with your actual Discord server and channel IDs

INSERT INTO sources (
  name,
  type,
  description,
  bucket,
  url,
  createdAt,
  updatedAt
)
VALUES (
  'Discord #general',  -- Give your source a descriptive name
  'discord',           -- Type must be 'discord'
  '{"guildID": "YOUR_GUILD_ID_HERE", "channelID": "YOUR_CHANNEL_ID_HERE"}',  -- JSON with Discord IDs
  'discord/',          -- Bucket path prefix
  'https://discord.com/channels/YOUR_GUILD_ID_HERE/YOUR_CHANNEL_ID_HERE',  -- Link to channel
  datetime('now'),
  datetime('now')
);

-- To find your Guild ID and Channel ID:
-- 1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
-- 2. Right-click on the server icon → Copy Server ID (this is the Guild ID)
-- 3. Right-click on the channel name → Copy Channel ID

-- Example with real-looking IDs:
-- INSERT INTO sources (name, type, description, bucket, url, createdAt, updatedAt)
-- VALUES (
--   'RedwoodJS Discord #core-team',
--   'discord',
--   '{"guildID": "1234567890123456789", "channelID": "9876543210987654321"}',
--   'discord/',
--   'https://discord.com/channels/1234567890123456789/9876543210987654321',
--   datetime('now'),
--   datetime('now')
-- );

