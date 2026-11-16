import { z } from '@hono/zod-openapi';

export const PlayPlaylistSchema = z.object({
  playlistId: z.string().openapi({
    description: 'id of the playlist to play, e.g. the VL-prefixed browseId',
    example: 'LM',
  }),
  index: z.number().int().nonnegative().optional().default(0).openapi({
    description: 'track of the playlist to start playback from',
  }),
  shuffle: z.boolean().optional().default(false),
});
