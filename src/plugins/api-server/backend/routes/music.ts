import { createRoute, z } from '@hono/zod-openapi';

import {
  getSongControls,
  InnertubeTimeoutError,
} from '@/providers/song-controls';

import { API_VERSION } from '../api-version';
import { BrowseSchema, PlayPlaylistSchema } from '../scheme';

import type { APIServerConfig } from '../../config';
import type { HonoApp } from '../types';
import type { BackendContext } from '@/types/contexts';
import type { Context } from 'hono';

// Same params value YouTube Music's own "Shuffle" button sends
const SHUFFLE_PARAMS = 'wAEB8gECKAE%3D';

const ErrorSchema = z.object({ error: z.string() });

// Finds the videoId of the nth track (0-based) in a playlist /browse response.
// Tracks are musicResponsiveListItemRenderer nodes; the id lives either in
// playlistItemData.videoId or the first watchEndpoint.videoId it contains.
const findNthTrackVideoId = (
  value: unknown,
  index: number,
): string | undefined => {
  let remaining = index;

  const videoIdOf = (renderer: Record<string, unknown>): string | undefined => {
    const playlistItemData = renderer.playlistItemData as
      | { videoId?: string }
      | undefined;
    if (playlistItemData?.videoId) return playlistItemData.videoId;

    let found: string | undefined;
    const search = (node: unknown) => {
      if (found || !node) return;
      if (Array.isArray(node)) {
        for (const item of node) search(item);
        return;
      }
      if (typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      const watchEndpoint = obj.watchEndpoint as
        | { videoId?: string }
        | undefined;
      if (watchEndpoint?.videoId) {
        found = watchEndpoint.videoId;
        return;
      }
      for (const child of Object.values(obj)) search(child);
    };
    search(renderer);
    return found;
  };

  const walk = (node: unknown): string | undefined => {
    if (!node) return undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const result = walk(item);
        if (result) return result;
      }
      return undefined;
    }
    if (typeof node !== 'object') return undefined;

    const obj = node as Record<string, unknown>;
    const renderer = obj.musicResponsiveListItemRenderer as
      | Record<string, unknown>
      | undefined;
    if (renderer) {
      if (remaining === 0) return videoIdOf(renderer);
      remaining -= 1;
      return undefined;
    }

    for (const child of Object.values(obj)) {
      const result = walk(child);
      if (result) return result;
    }
    return undefined;
  };

  return walk(value);
};

const routes = {
  browse: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/browse`,
    summary: 'browse a YouTube Music page',
    description:
      'Get a raw YouTube Music browse page (like /search). Useful browseIds: ' +
      "FEmusic_liked_playlists (the user's library playlists), " +
      "VL<playlistId> (a playlist's tracks, works for private playlists), " +
      'VLLM (Liked songs), FEmusic_home (home feed). Pass the continuation ' +
      'token from a previous response to load more.',
    request: {
      body: {
        description: 'browse id of the page',
        content: {
          'application/json': {
            schema: BrowseSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Success',
        content: { 'application/json': { schema: z.object({}) } },
      },
      502: {
        description: 'YouTube Music request failed',
        content: { 'application/json': { schema: ErrorSchema } },
      },
      504: {
        description: 'YouTube Music did not respond in time',
        content: { 'application/json': { schema: ErrorSchema } },
      },
    },
  }),
  playPlaylist: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/play-playlist`,
    summary: 'play a playlist',
    description:
      'Replace the queue with a playlist and start playing it, optionally ' +
      "at a given track index or shuffled (using YouTube Music's own shuffle).",
    request: {
      body: {
        description: 'playlist to play',
        content: {
          'application/json': {
            schema: PlayPlaylistSchema,
          },
        },
      },
    },
    responses: {
      204: { description: 'Success' },
      404: {
        description: 'No track at the given index',
        content: { 'application/json': { schema: ErrorSchema } },
      },
      502: {
        description: 'YouTube Music request failed',
        content: { 'application/json': { schema: ErrorSchema } },
      },
      503: {
        description: 'YouTube Music is not ready to start playback',
        content: { 'application/json': { schema: ErrorSchema } },
      },
      504: {
        description: 'YouTube Music did not respond in time',
        content: { 'application/json': { schema: ErrorSchema } },
      },
    },
  }),
};

const requestError = (ctx: Context, error: unknown) =>
  ctx.json(
    { error: error instanceof Error ? error.message : String(error) },
    error instanceof InnertubeTimeoutError ? 504 : 502,
  );

export const register = (
  app: HonoApp,
  { window }: BackendContext<APIServerConfig>,
) => {
  const controller = getSongControls(window);

  app.openapi(routes.browse, async (ctx) => {
    const { browseId, params, continuation } = ctx.req.valid('json');
    try {
      const response = await controller.innertubeRequest('/browse', {
        browseId,
        params,
        continuation,
      });

      ctx.status(200);
      return ctx.json(response as object);
    } catch (error) {
      return requestError(ctx, error);
    }
  });

  app.openapi(routes.playPlaylist, async (ctx) => {
    const { playlistId, index, shuffle } = ctx.req.valid('json');
    const params = shuffle ? SHUFFLE_PARAMS : undefined;

    let videoId: string | undefined;
    if (index > 0) {
      try {
        const browseId = playlistId.startsWith('VL')
          ? playlistId
          : `VL${playlistId}`;
        const data = await controller.innertubeRequest('/browse', { browseId });
        videoId = findNthTrackVideoId(data, index);
      } catch (error) {
        return requestError(ctx, error);
      }

      if (!videoId) {
        ctx.status(404);
        return ctx.json({ error: `No track at index ${index}` });
      }
    }

    const endpoint = videoId
      ? { watchEndpoint: { videoId, playlistId, index, params } }
      : { watchPlaylistEndpoint: { playlistId, params } };

    const dispatched = await controller.playEndpoint(endpoint);
    if (!dispatched) {
      ctx.status(503);
      return ctx.json({
        error: 'YouTube Music is not ready to start playback',
      });
    }

    ctx.status(204);
    return ctx.body(null);
  });
};
