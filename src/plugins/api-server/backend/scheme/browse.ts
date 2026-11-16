import { z } from '@hono/zod-openapi';

export const BrowseSchema = z.object({
  browseId: z.string().openapi({
    description:
      "Browse id of the page, e.g. FEmusic_liked_playlists (library playlists), VLLM (liked songs), VL<playlistId> (a playlist's tracks), FEmusic_home (home feed)",
    example: 'FEmusic_liked_playlists',
  }),
  params: z.string().optional(),
  continuation: z.string().optional(),
});
