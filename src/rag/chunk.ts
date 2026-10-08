// Pure chunking logic for the KB: splits markdown into heading-scoped windows
// of roughly 500-800 characters, the unit RAG embeds and retrieves. No I/O —
// this module is the one unit-tested directly against a tiny fixed corpus.

export interface KbChunk {
  /** Stable id: "<source>#<index>". */
  id: string;
  /** Source file, e.g. "network-triage.md". */
  source: string;
  /** The nearest markdown heading above this chunk ("" if the file has none yet). */
  heading: string;
  /** Chunk text, heading included as a one-line prefix so retrieval keeps context. */
  text: string;
}

export interface ChunkOptions {
  /** Target minimum chunk size before allowing a flush at a paragraph boundary. Default 500. */
  minChars?: number;
  /** Hard cap before a chunk is flushed even mid-paragraph. Default 800. */
  maxChars?: number;
}

interface Block {
  heading: string;
  paragraph: string;
}

/** Splits markdown into (heading, paragraph) blocks. Blank lines separate paragraphs; `#`-lines update the heading. */
function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let heading = "";
  let buffer: string[] = [];

  const flushParagraph = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (text.length > 0) blocks.push({ heading, paragraph: text });
  };

  for (const line of markdown.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      flushParagraph();
      heading = line.replace(/^#{1,6}\s+/, "").trim();
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    buffer.push(line);
  }
  flushParagraph();
  return blocks;
}

/** Chunks one markdown document (headings + ~500-800 char windows), never crossing a heading boundary. */
export function chunkMarkdown(source: string, markdown: string, options: ChunkOptions = {}): KbChunk[] {
  const minChars = options.minChars ?? 500;
  const maxChars = options.maxChars ?? 800;
  const blocks = splitBlocks(markdown);

  const chunks: KbChunk[] = [];
  let index = 0;
  let heading = "";
  let current = "";

  const flush = () => {
    const text = current.trim();
    current = "";
    if (text.length === 0) return;
    const prefixed = heading ? `${heading}\n\n${text}` : text;
    chunks.push({ id: `${source}#${index}`, source, heading, text: prefixed });
    index += 1;
  };

  for (const block of blocks) {
    if (block.heading !== heading) {
      // A new section always starts a new chunk — RAG hits should stay scoped to one topic.
      flush();
      heading = block.heading;
    }

    const candidate = current.length > 0 ? `${current}\n\n${block.paragraph}` : block.paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    // Adding this paragraph would overflow. Flush what we have (if it already
    // reached the minimum) before starting a fresh window with this paragraph.
    if (current.length >= minChars || current.length === 0) {
      flush();
      current = block.paragraph;
      // A single paragraph longer than maxChars is split on its own into hard windows.
      while (current.length > maxChars) {
        chunks.push({
          id: `${source}#${index}`,
          source,
          heading,
          text: heading ? `${heading}\n\n${current.slice(0, maxChars)}` : current.slice(0, maxChars),
        });
        index += 1;
        current = current.slice(maxChars);
      }
    } else {
      // Below the minimum: accept the overflow rather than emit a tiny chunk.
      current = candidate;
    }
  }
  flush();

  return chunks;
}

/** Chunks a whole KB directory's worth of (filename, content) pairs. */
export function chunkKb(files: Array<{ name: string; content: string }>, options?: ChunkOptions): KbChunk[] {
  return files.flatMap(({ name, content }) => chunkMarkdown(name, content, options));
}
