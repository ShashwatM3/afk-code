import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

// Common image extensions
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif'
]);

// Audio, video and document extensions that Telegram can receive as files
const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.ogg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);

const IMAGE_EXT_RE = 'png|jpe?g|gif|webp|svg|bmp|ico|tiff?';
const MEDIA_EXT_RE = `${IMAGE_EXT_RE}|m4a|mp3|wav|ogg|mp4|mov|webm|pdf`;

// Regex to match file paths that could be images
// Matches: /absolute/path.png, ./relative/path.jpg, ~/home/path.gif, "quoted/path.png"
function pathPattern(ext: string): RegExp {
  return new RegExp(
    `(?:["'\`]([^"'\`\\n]+\\.(?:${ext}))|(?:^|[\\s(])([~./][^\\s)"'\`\\n]*\\.(?:${ext})))`,
    'gi'
  );
}
const PATH_PATTERN = pathPattern(IMAGE_EXT_RE);
const MEDIA_PATH_PATTERN = pathPattern(MEDIA_EXT_RE);

export type MediaKind = 'image' | 'animation' | 'audio' | 'video' | 'document';

export interface ExtractedImage {
  originalPath: string;
  resolvedPath: string;
}

export interface ExtractedMedia extends ExtractedImage {
  kind: MediaKind;
}

export function mediaKind(resolvedPath: string): MediaKind | null {
  const ext = resolvedPath.toLowerCase().slice(resolvedPath.lastIndexOf('.'));
  if (ext === '.gif') return 'animation';
  if (ext === '.svg' || DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

function extractPaths(pattern: RegExp, content: string, cwd: string | undefined, accept: (ext: string) => boolean): ExtractedImage[] {
  const found: ExtractedImage[] = [];
  const seen = new Set<string>();

  // Reset regex state
  pattern.lastIndex = 0;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    // Get the captured path (from quoted or unquoted group)
    const originalPath = (match[1] || match[2]).trim();

    if (!originalPath || seen.has(originalPath)) continue;
    seen.add(originalPath);

    // Resolve the path
    let resolvedPath = originalPath;

    // Handle home directory
    if (resolvedPath.startsWith('~/')) {
      resolvedPath = resolve(homedir(), resolvedPath.slice(2));
    }
    // Handle relative paths
    else if (resolvedPath.startsWith('./') || resolvedPath.startsWith('../')) {
      resolvedPath = resolve(cwd || process.cwd(), resolvedPath);
    }
    // Handle absolute paths (already resolved)
    else if (!resolvedPath.startsWith('/')) {
      // Not a recognizable path format, skip
      continue;
    }

    // Verify file exists and is a file (not directory)
    try {
      if (existsSync(resolvedPath)) {
        const stat = statSync(resolvedPath);
        if (stat.isFile()) {
          // Check extension
          const ext = resolvedPath.toLowerCase().slice(resolvedPath.lastIndexOf('.'));
          if (accept(ext)) {
            found.push({ originalPath, resolvedPath });
          }
        }
      }
    } catch {
      // File doesn't exist or can't be accessed, skip
    }
  }

  return found;
}

/**
 * Extract image paths from text content and verify they exist on disk
 */
export function extractImagePaths(content: string, cwd?: string): ExtractedImage[] {
  return extractPaths(PATH_PATTERN, content, cwd, (ext) => IMAGE_EXTENSIONS.has(ext));
}

/**
 * Extract image, audio, video and PDF paths from text content and verify they exist on disk
 */
export function extractMediaPaths(content: string, cwd?: string): ExtractedMedia[] {
  return extractPaths(MEDIA_PATH_PATTERN, content, cwd, (ext) => mediaKind(`x${ext}`) !== null)
    .map((m) => ({ ...m, kind: mediaKind(m.resolvedPath) as MediaKind }));
}
