# Discord scope routing

## Problem
Discord documents are currently routed to Moment Graph namespaces using an explicit allowlist of channel IDs.

This causes two issues:
- Most Discord channel/day documents route to `redwood:internal` unless their channel ID is manually listed.
- Routing decisions depend on repository configuration rather than Discord source identity, which makes it easy to route unrelated Discord content into the wrong project namespace.

## Constraints
- Routing must be deterministic based on document metadata available at indexing time.
- Routing must not require reading and inspecting message text.
- The default routing must not require code edits when channel coverage expands.

## Approach
Route Discord documents using a two-step decision:

1. If the channel ID is listed as a machinen channel, route to `redwood:machinen`.
2. Else, if the channel ID is listed as a public rwsdk channel, route to `redwood:rwsdk`.
3. Else, route to `redwood:internal`.

The routing decision is made from Discord source metadata derived from the R2 key:
- `guildID` and `channelID` are parsed from the R2 key shape.
- Thread documents reuse the parent `channelID` from their R2 key.

The configuration inputs are hardcoded in the org-specific scope router plugin:
- A set of machinen Discord channel IDs.
- A set of public rwsdk Discord channel IDs.

## Functional outcomes
- Discord channel/day documents from public channels route to `redwood:rwsdk`.
- Machinen Discord activity routes to `redwood:machinen`.
- Discord documents from other channels route to `redwood:internal`.

## Initial channel mapping

Guild:
- `679514959968993311`

Machinen:
- `1435702216315899948`

Public rwsdk:
- `1307974274145062912`
- `1449132150392750080`

