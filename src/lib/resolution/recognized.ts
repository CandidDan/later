import type { SourceType } from "./result";

export interface RecognizedSource {
  sourceType: SourceType;
  canonicalUrl: string;
}
function youtubeVideo(url: URL): RecognizedSource | undefined {
  const hostname = url.hostname.toLowerCase();
  const id = hostname === "youtu.be"
    ? url.pathname.split("/").filter(Boolean)[0]
    : (hostname === "youtube.com" || hostname === "www.youtube.com" || hostname === "m.youtube.com")
      && url.pathname === "/watch"
      ? url.searchParams.get("v") ?? undefined
      : undefined;
  if (!id || !/^[A-Za-z0-9_-]{6,32}$/u.test(id)) return undefined;
  return { sourceType: "youtube_video", canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
}

function spotifySource(url: URL): RecognizedSource | undefined {
  if (url.hostname.toLowerCase() !== "open.spotify.com") return undefined;
  const [kind, id] = url.pathname.split("/").filter(Boolean);
  if ((kind !== "episode" && kind !== "show") || !id || !/^[A-Za-z0-9]{10,32}$/u.test(id)) {
    return undefined;
  }
  return {
    sourceType: kind === "episode" ? "spotify_episode" : "spotify_show",
    canonicalUrl: `https://open.spotify.com/${kind}/${id}`,
  };
}

/** Recognize identities whose canonical URL follows from a platform identifier alone. */
export function recognizeSource(rawUrl: string): RecognizedSource | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  return youtubeVideo(url) ?? spotifySource(url);
}
