import '@logseq/libs'
import { SettingSchemaDesc, BlockEntity, IBatchBlock, BlockUUID } from '@logseq/libs/dist/LSPlugin'
import { parse as luaparse } from 'luaparse'
import { ProgressNotification } from './progress'
import { get as getStorage, set as setStorage, del as delStorage } from 'idb-keyval';

let settings: SettingSchemaDesc[] = [
  {
    key: "rememberDirectory",
    default: true,
    description: "Remember saved path to KOReader files. Uncheck to clear saved path, but remember to switch it back on after.",
    title: "Remember KOReader Path",
    type: "boolean",
  },
]

const delay = (t = 100) => new Promise(r => setTimeout(r, t))

function onSettingsChange() {
  console.log("settings changed.");
  if (!(logseq.settings?.rememberDirectory)) {
    delStorage('logseq_koreader_sync__directoryHandle')
  }
}

function truncateString(str: any, length: number) {
  if (!str) return '';
  return str.length > length ? str.slice(0, length) : str;
}

const MAXIMUM_DESCRIPTION_LENGTH = 250;
const COLLAPSE_BLOCKS = true;

const KOREADER_COLOR_EMOJI: Record<string, string> = {
  red: '🔴',
  orange: '🟠',
  yellow: '🟡',
  green: '🟢',
  olive: '🟤',
  cyan: '🩵',
  blue: '🔵',
  purple: '🟣',
  gray: '🔘',
};

function koreaderColorLabel(color?: string): string | undefined {
  if (!color) return undefined;
  const emoji = KOREADER_COLOR_EMOJI[color.toLowerCase()];
  return emoji ? `${emoji} ${color}` : color;
}

function koreaderDrawerLabel(drawer?: string): string | undefined {
  if (!drawer) return undefined;
  const labels: Record<string, string> = {
    underscore: 'underscore',
    lighten: 'lighten',
    strikethrough: 'strikethrough',
    invert: 'invert',
  };
  return labels[drawer.toLowerCase()] ?? drawer;
}

// Safely extracts the most recent timestamp available for a highlight
function getItemTimestamp(item: any): string | undefined {
  return item.datetime_updated || item.datetime;
}

// ==========================================
// NAVIGATION & INSERTION HELPERS
// ==========================================

async function waitForPage(pageName: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const currentPage = await logseq.Editor.getCurrentPage();
    if (currentPage?.originalName === pageName) return true;
    await delay(100);
  }
  return false;
}

async function appendAsLastChild(parentUuid: string, block: IBatchBlock, lastChildUuid: string | null): Promise<string | null> {
  let inserted;
  if (lastChildUuid) {
    inserted = await logseq.Editor.insertBatchBlock(lastChildUuid, [block], { sibling: true });
  } else {
    inserted = await logseq.Editor.insertBatchBlock(parentUuid, [block], { sibling: false });
  }
  const newBlock = Array.isArray(inserted) ? inserted[0] : inserted;
  return newBlock?.uuid ?? null;
}

async function appendManyAsLastChildren(parentUuid: string, blocks: IBatchBlock[], lastChildUuid: string | null): Promise<string[]> {
  if (blocks.length === 0) return [];
  let inserted;
  if (lastChildUuid) {
    inserted = await logseq.Editor.insertBatchBlock(lastChildUuid, blocks, { sibling: true });
  } else {
    inserted = await logseq.Editor.insertBatchBlock(parentUuid, blocks, { sibling: false });
  }
  const arr = Array.isArray(inserted) ? inserted : (inserted ? [inserted] : []);
  return arr.map((b: any) => b?.uuid).filter(Boolean) as string[];
}

// ==========================================
// POSITION SORTING HELPERS (XPointer Sorting)
// ==========================================

function positionKey(pos?: string): number[] {
  if (!pos) return [];
  const matches = pos.match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

function comparePositions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function sortByPosition(items: any[]): any[] {
  if (!items) return [];
  return [...items].sort((a, b) => {
    const posA = positionKey(a.pos0);
    const posB = positionKey(b.pos0);
    if (posA.length && posB.length) {
      const cmp = comparePositions(posA, posB);
      if (cmp !== 0) return cmp;
    }

    const pageA = typeof a.pageno === 'number' ? a.pageno : (parseFloat(a.pageno) || typeof a.page === 'number' ? a.page : parseFloat(a.page) || 0);
    const pageB = typeof b.pageno === 'number' ? b.pageno : (parseFloat(b.pageno) || typeof b.page === 'number' ? b.page : parseFloat(b.page) || 0);
    if (pageA !== pageB) return pageA - pageB;
    return (a.datetime || '').localeCompare(b.datetime || '');
  });
}

function computeBookMaxDatetimeUpdated(items: any[]): string | undefined {
  if (!items || items.length === 0) return undefined;
  let maxStamp: string | undefined = undefined;

  for (const item of items) {
    const stamp = getItemTimestamp(item);
    if (stamp) {
      if (!maxStamp || stamp > maxStamp) {
        maxStamp = stamp;
      }
    }
  }

  return maxStamp;
}

// Writes properties explicitly into the Markdown block drawer
async function applyPropertiesToBlock(uuid: string, props: Record<string, any>) {
  for (const [key, val] of Object.entries(props)) {
    if (val !== undefined && val !== null && val !== '') {
      await logseq.Editor.upsertBlockProperty(uuid, key, val);
    }
  }
}

// ==========================================

/** Converts KOReader metadata into Logseq batch block structure. */
function metadata_to_block(metadata: any): IBatchBlock | null {
  if (!metadata.doc_props || typeof metadata.doc_props !== 'object' || Object.keys(metadata.doc_props).length === 0) {
    return null;
  }

  if (!metadata.annotations) {
    return handle_bookmarks_metadata(metadata);
  } else {
    return handle_annotations_metadata(metadata);
  }
}

function handle_annotations_metadata(metadata: any): IBatchBlock | null {
  if (typeof metadata.annotations === 'object' && Object.keys(metadata.annotations).length === 0) {
    return null;
  }

  let bookmarks: IBatchBlock[] = [];

  let authors = metadata.doc_props.authors;
  if (authors) {
    authors = authors.replace(/\\\n/g, ', ');
  }

  const bookMaxDatetime = computeBookMaxDatetimeUpdated(metadata.annotations);

  if (!metadata.annotations) {
    return {
      content: `## ${metadata.doc_props.title}`,
      properties: {
        'authors': authors,
        'description': truncateString(metadata.doc_props.description, MAXIMUM_DESCRIPTION_LENGTH),
        'language': metadata.doc_props.language,
        'datetime_updated': bookMaxDatetime,
      }
    }
  }

  for (const annotation of sortByPosition(metadata.annotations)) {
    let personal_note: IBatchBlock[] = [];
    if (annotation.note) {
      personal_note.push({
        content: annotation.note.replace(/-/g, '\\-'),
      });
    }

    let text_content: string = "> (no text available)";
    if (!annotation.pos0) {
      text_content = "> Page bookmark";
    } else if (annotation.text) {
      text_content = `> ${annotation.text.replace(/-/g, '\\-')}`;
    }

    const timestamp = getItemTimestamp(annotation);

    bookmarks.push(
      {
        content: text_content,
        properties: {
          'datetime': annotation.datetime,
          'datetime_updated': timestamp,
          'page': annotation.pageno,
          'chapter': annotation.chapter,
          'color': koreaderColorLabel(annotation.color),
          'drawer': koreaderDrawerLabel(annotation.drawer),
          'pos0': annotation.pos0,
          'collapsed': COLLAPSE_BLOCKS && personal_note.length > 0,
        },
        children: personal_note
      }
    )
  }

  return {
    content: `## ${metadata.doc_props.title}`,
    properties: {
      'authors': authors,
      'description': truncateString(metadata.doc_props.description, MAXIMUM_DESCRIPTION_LENGTH),
      'language': metadata.doc_props.language,
      'datetime_updated': bookMaxDatetime,
      'collapsed': COLLAPSE_BLOCKS,
    },
    children: [
      {
        content: `### Bookmarks`,
        children: bookmarks
      }
    ]
  }
}

function handle_bookmarks_metadata(metadata: any): IBatchBlock | null {
  if (typeof metadata.bookmarks === 'object' && Object.keys(metadata.bookmarks).length === 0) {
    return null;
  }

  let bookmarks: IBatchBlock[] = [];

  let authors = metadata.doc_props.authors;
  if (authors) {
    authors = authors.replace(/\\\n/g, ', ');
  }

  const bookMaxDatetime = computeBookMaxDatetimeUpdated(metadata.bookmarks);

  if (!metadata.bookmarks) {
    return {
      content: `## ${metadata.doc_props.title}`,
      properties: {
        'authors': authors,
        'description': truncateString(metadata.doc_props.description, MAXIMUM_DESCRIPTION_LENGTH),
        'language': metadata.doc_props.language,
        'datetime_updated': bookMaxDatetime,
      }
    }
  }

  for (const bookmark of sortByPosition(metadata.bookmarks)) {
    let personal_note: IBatchBlock[] = [];
    if (bookmark.text) {
      personal_note.push({
        content: bookmark.text,
      });
    }

    const timestamp = getItemTimestamp(bookmark);

    bookmarks.push(
      {
        content: `> ${bookmark.notes ? bookmark.notes.replace(/-/g, '\\-') : ''}`,
        properties: {
          'datetime': bookmark.datetime,
          'datetime_updated': timestamp,
          'page': bookmark.page,
          'chapter': bookmark.chapter,
          'color': koreaderColorLabel(bookmark.color),
          'drawer': koreaderDrawerLabel(bookmark.drawer),
          'pos0': bookmark.pos0,
          'collapsed': COLLAPSE_BLOCKS && personal_note.length > 0,
        },
        children: personal_note
      }
    )
  }

  return {
    content: `## ${metadata.doc_props.title}`,
    properties: {
      'authors': authors,
      'description': truncateString(metadata.doc_props.description, MAXIMUM_DESCRIPTION_LENGTH),
      'language': metadata.doc_props.language,
      'datetime_updated': bookMaxDatetime,
      'collapsed': COLLAPSE_BLOCKS,
    },
    children: [
      {
        content: `### Bookmarks`,
        children: bookmarks
      }
    ]
  }
}

function lua_to_block(text: string): IBatchBlock | null {
  const ast = luaparse(text, {
    comments: false,
    locations: false,
    ranges: false,
    luaVersion: 'LuaJIT'
  });

  var metadata: any = {};

  for (const field in (ast.body[0] as any).arguments[0].fields) {
    const target = (ast.body[0] as any).arguments[0].fields[field]
    const key = target.key.raw.replace(/"/g, '');

    if (key === "stats") continue;

    if (target.value.type === "TableConstructorExpression") {
      if (target.value.fields[0] && target.value.fields[0].value.type === "TableConstructorExpression") {
        metadata[key] = [];
      } else {
        metadata[key] = {};
      }

      for (const subfield in target.value.fields) {
        const subtarget = target.value.fields[subfield];
        if (subtarget.value.type === "TableConstructorExpression") {
          const sub_dictionary: any = {};

          for (const subsubfield in subtarget.value.fields) {
            const subsubtarget = subtarget.value.fields[subsubfield];
            const subkey = subsubtarget.key.raw.replace(/"/g, '');
            sub_dictionary[subkey] = subsubtarget.value.raw?.replace(/"/g, '');
          }
          metadata[key].push(sub_dictionary);
        } else {
          metadata[key][subtarget.key.raw.replace(/"/g, '')] = subtarget.value.raw?.replace(/"/g, '');
        }
      }
    } else {
      metadata[key] = target.value.raw?.replace(/"/g, '');
    }
  }

  return metadata_to_block(metadata);
}

async function* walkDirectory(directoryHandle: any): AsyncGenerator<any> {
  if (directoryHandle.kind === "file") {
    const file = await directoryHandle.getFile();
    if (file !== null && file.name.toLowerCase().endsWith('.lua') && file.name.toLowerCase().includes('metadata')) {
      yield file;
    }
  } else if (directoryHandle.kind === "directory") {
    for await (const handle of directoryHandle.values()) {
      yield* walkDirectory(handle);
    }
  }
}

async function verifyPermission(fileHandle: any) {
  if ((await fileHandle.queryPermission({})) === 'granted') return true;
  if ((await fileHandle.requestPermission({})) === 'granted') return true;
  return false;
}

declare global {
  interface Window {
    showDirectoryPicker: any;
  }
}

function main () {
  let loading = false;

  logseq.useSettingsSchema(settings)
  logseq.provideModel({
    async syncKOReader () {
      onSettingsChange();
      logseq.onSettingsChanged(onSettingsChange);

      if (loading) {
        console.warn('LKRS: a sync is already running — ignoring click');
        return;
      }
      loading = true;

      let syncProgress: ProgressNotification | null = null;

      let newBooksCount = 0;
      let updatedBooksCount = 0;
      let skippedBooksCount = 0;
      let newHighlightsCount = 0;
      let updatedHighlightsCount = 0;

      try {
        const pageName = '_logseq-koreader-sync'
        const syncTimeLabel = (new Date()).toLocaleString()

        logseq.App.pushState('page', { name: pageName })
        
        const arrived = await waitForPage(pageName);
        if (!arrived) {
          console.error('LKRS: timed out waiting to navigate to sync page');
          logseq.UI.showMsg('KOReader sync failed: timed out navigating to sync page', 'error');
          return;
        }

        const currentPage = await logseq.Editor.getCurrentPage();
        const pageBlocksTree = await logseq.Editor.getCurrentPageBlocksTree()

        let targetBlock : BlockEntity | null = null;
        let warningBlockFound = false;
        for (const block of pageBlocksTree) {
          if (block?.content.includes("LKRS")) {
            targetBlock = block;
            continue;
          }
          else if (block?.content.includes("BEGIN_WARNING")) {
            warningBlockFound = true;
          }
        }

        if (!warningBlockFound) {
          await logseq.Editor.insertBatchBlock(currentPage!.uuid, [{ content: "\n#+BEGIN_WARNING\nPlease do not edit this page; stick to block references made elsewhere.\n#+END_WARNING" }], { sibling: false})
        }

        const original_content = targetBlock?.content;
        if (targetBlock === null || targetBlock === undefined) {
          targetBlock = await logseq.Editor.insertBlock(currentPage!.uuid, '🚀 LKRS: Please Select KOReader Metadata Directory ...',)
        } else {
          await logseq.Editor.updateBlock(targetBlock!.uuid, `🚀 LKRS: Please Select KOReader Metadata Directory ...`)
        }

        let directoryHandle : any = await getStorage('logseq_koreader_sync__directoryHandle');

        let permission;
        if (directoryHandle) {
          permission = await verifyPermission(directoryHandle);
        }

        if (!directoryHandle || !permission) {
          try {
            directoryHandle = await window.showDirectoryPicker()
          } catch (e) {
            if (original_content) {
              await logseq.Editor.updateBlock(targetBlock!.uuid, original_content)
            } else {
              await logseq.Editor.updateBlock(targetBlock!.uuid, "# ❌ LKRS: Sync cancelled by user.")
            }
            console.error(e);
            return;
          }

          if (logseq.settings?.rememberDirectory) {
            setStorage('logseq_koreader_sync__directoryHandle', directoryHandle);
          }
        }

        if (!directoryHandle) {
          console.error('No directory selected / found.')
          return;
        }

        await logseq.Editor.updateBlock(targetBlock!.uuid, `# ⚙ LKRS: Processing KOReader Annotations ...`)

        let fileCount = 0;
        for await (const _ of walkDirectory(directoryHandle)) { fileCount++; };

        let ret;
        try {
          ret = await logseq.DB.datascriptQuery(`
          [
              :find (pull ?b [:block/content :block/uuid :block/properties]) ?authors
              :where
                [?b :block/parent ?p]
                [?p :block/uuid #uuid "${targetBlock!.uuid}"]
                [?b :block/properties ?props]
                [(get ?props :authors) ?authors]
          ]
          `)
        } catch (e) {
          console.error("Error while iterating over blocks in the target page: ", e);
          return;
        }

        const titleMatch : RegExp = /##\s+(.*?)\n/;

        let existingBlocks: Record<string, { uuid: string; datetime_updated?: string }> = {}
        for (const block of ret) {
          const authors = block[1];
          const blockData = block[0];
          const content = blockData["content"];
          const match = content?.match(titleMatch);
          let title = match ? match[1] : "";

          const key = authors + "___" + title;
          if (!(key in existingBlocks)) {
            let block_uuid = blockData["uuid"];
            if (block_uuid) {
              existingBlocks[key] = {
                uuid: block_uuid,
                datetime_updated: blockData.properties?.datetime_updated,
              };
            }
          }
        }

        const updatedTargetBlock = await logseq.Editor.getBlock(targetBlock!.uuid, { includeChildren: true });
        let lastBookChildUuid: string | null = (updatedTargetBlock?.children && updatedTargetBlock.children.length > 0)
          ? (updatedTargetBlock.children[updatedTargetBlock.children.length - 1] as any)[1]
          : null;

        syncProgress = new ProgressNotification("Syncing Koreader Annotations to Logseq:", fileCount);
        for await (const fileHandle of walkDirectory(directoryHandle)) {
          var text = await fileHandle.text();
          var parsed_block = lua_to_block(text);

          if (parsed_block && parsed_block.children && parsed_block.children.length > 0) {
            let key: string;
            if (parsed_block.properties!.authors === undefined) {
              key = "___" + parsed_block.content.substring(3);
            } else {
              key = parsed_block.properties!.authors + "___" + parsed_block.content.substring(3);
            }

            if (key in existingBlocks) {
              const existing_book_entry = existingBlocks[key];
              const incoming_book_datetime_updated = parsed_block.properties?.datetime_updated;

              // WHOLE-BOOK SKIP CHECK
              if (
                incoming_book_datetime_updated &&
                existing_book_entry.datetime_updated &&
                incoming_book_datetime_updated <= existing_book_entry.datetime_updated
              ) {
                skippedBooksCount++;
                syncProgress.increment(1);
                continue;
              }

              const existing_block = await logseq.Editor.getBlock(existing_book_entry.uuid);
              if (existing_block === null) continue;

              let existing_bookmark_blocks;
              let existing_bookmark_block_uuid;

              for (const child of existing_block!.children!) {
                let child_block = await logseq.Editor.getBlock(child[1] as BlockEntity);

                if (child_block && child_block.content && child_block.content.includes("### Bookmarks")) {
                  existing_bookmark_blocks = child_block.children || [];
                  existing_bookmark_block_uuid = child[1];
                  break;
                }
              }

              if (existing_bookmark_block_uuid === undefined) {
                console.error("Bookmarks block not found for: ", existing_book_entry.uuid);
                continue;
              }

              let existing_bookmarks: Record<string, any> = {};
              let orderedBookmarks: { uuid: string, posKey: number[] }[] = [];

              for (const bookmark of existing_bookmark_blocks) {
                let bookmark_block = await logseq.Editor.getBlock(bookmark[1] as BlockEntity);
                if (!bookmark_block) continue;

                const storedPos = bookmark_block.properties?.pos0;
                const storedPage = bookmark_block.properties?.page;
                const storedDatetimeUpdated = bookmark_block.properties?.datetime_updated;
                const parsedPosKey = positionKey(storedPos);

                if (parsedPosKey.length) {
                  existing_bookmarks[parsedPosKey.join(':')] = {
                    uuid: bookmark_block.uuid,
                    datetime_updated: storedDatetimeUpdated,
                  };
                } else if (storedPage !== undefined && storedPage !== null && storedPage !== '') {
                  existing_bookmarks[`page:${typeof storedPage === 'number' ? storedPage : (parseFloat(storedPage) || 999999)}`] = {
                    uuid: bookmark_block.uuid,
                    datetime_updated: storedDatetimeUpdated,
                  };
                }

                const posKey = parsedPosKey.length
                  ? parsedPosKey
                  : [typeof storedPage === 'number' ? storedPage : (parseFloat(storedPage) || 999999)];

                orderedBookmarks.push({ uuid: bookmark[1] as string, posKey });
              }

              orderedBookmarks.sort((a, b) => comparePositions(a.posKey, b.posKey));

              const trailingBatch: IBatchBlock[] = [];
              const trailingBatchPosKeys: number[][] = [];

              const incomingHighlights = parsed_block.children[0].children || [];
              for (const bookmark of incomingHighlights) {
                const incomingPos = positionKey(bookmark.properties?.pos0);
                const incomingPage = bookmark.properties?.page;
                const incomingKey = incomingPos.length
                  ? incomingPos.join(':')
                  : `page:${typeof incomingPage === 'number' ? incomingPage : (parseFloat(incomingPage) || 999999)}`;

                const incomingTimestamp = getItemTimestamp(bookmark.properties);

                if (incomingKey in existing_bookmarks) {
                  const existing_entry = existing_bookmarks[incomingKey];
                  const existing_uuid = typeof existing_entry === 'string' ? existing_entry : existing_entry.uuid;
                  const existing_datetime_updated = typeof existing_entry === 'string' ? undefined : existing_entry.datetime_updated;

                  if (
                    incomingTimestamp &&
                    existing_datetime_updated &&
                    incomingTimestamp <= existing_datetime_updated
                  ) {
                    continue;
                  }

                  let existing_bookmark = await logseq.Editor.getBlock(existing_uuid);

                  if (existing_bookmark) {
                    await applyPropertiesToBlock(existing_bookmark.uuid, {
                      color: koreaderColorLabel(bookmark.properties?.color),
                      drawer: koreaderDrawerLabel(bookmark.properties?.drawer),
                      datetime_updated: incomingTimestamp,
                      pos0: bookmark.properties?.pos0,
                    });
                    updatedHighlightsCount++;
                  }
                } else {
                  // POSITION-AWARE INSERTION
                  const newPosKey = positionKey(bookmark.properties?.pos0).length
                    ? positionKey(bookmark.properties?.pos0)
                    : [typeof bookmark.properties?.page === 'number' ? bookmark.properties!.page : 999999];

                  const nextIdx = orderedBookmarks.findIndex(b => comparePositions(newPosKey, b.posKey) < 0);

                  if (nextIdx === -1) {
                    trailingBatch.push(bookmark);
                    trailingBatchPosKeys.push(newPosKey);
                  } else {
                    const target = orderedBookmarks[nextIdx];
                    const inserted = await logseq.Editor.insertBatchBlock(target.uuid, [bookmark], { sibling: true, before: true });
                    const newBlock = Array.isArray(inserted) ? inserted[0] : inserted;
                    const insertedUuid = newBlock?.uuid ?? null;
                    if (insertedUuid) {
                      await applyPropertiesToBlock(insertedUuid, {
                        ...bookmark.properties,
                        datetime_updated: incomingTimestamp,
                      });
                      orderedBookmarks.splice(nextIdx, 0, { uuid: insertedUuid, posKey: newPosKey });
                      newHighlightsCount++;
                    }
                  }
                }
              }

              // FLUSH TRAILING BATCH IN ONE CALL
              if (trailingBatch.length > 0) {
                const lastUuid = orderedBookmarks.length ? orderedBookmarks[orderedBookmarks.length - 1].uuid : null;
                const insertedUuids = await appendManyAsLastChildren(existing_bookmark_block_uuid as string, trailingBatch, lastUuid);
                for (let i = 0; i < insertedUuids.length; i++) {
                  const uuid = insertedUuids[i];
                  const bm = trailingBatch[i];
                  await applyPropertiesToBlock(uuid, {
                    ...bm.properties,
                    datetime_updated: getItemTimestamp(bm.properties),
                  });
                  orderedBookmarks.push({ uuid, posKey: trailingBatchPosKeys[i] });
                }
                newHighlightsCount += insertedUuids.length;
              }

              if (incoming_book_datetime_updated) {
                await logseq.Editor.upsertBlockProperty(
                  existing_book_entry.uuid,
                  'datetime_updated',
                  incoming_book_datetime_updated
                );
                existing_book_entry.datetime_updated = incoming_book_datetime_updated;
              }
              updatedBooksCount++;
            } else {
              // INSERT BRAND NEW BOOK
              const insertedUuid = await appendAsLastChild(targetBlock!.uuid, parsed_block, lastBookChildUuid);
              if (insertedUuid) {
                lastBookChildUuid = insertedUuid;
                await applyPropertiesToBlock(insertedUuid, parsed_block.properties || {});
                existingBlocks[key] = {
                  uuid: insertedUuid,
                  datetime_updated: parsed_block.properties?.datetime_updated,
                };
                newBooksCount++;
              }
            }
          }
          syncProgress.increment(1);
        }

        await logseq.Editor.updateBlock(targetBlock!.uuid, `# 📚 LKRS: KOReader - Sync Initiated at ${syncTimeLabel}`)

        logseq.UI.showMsg(
          `KOReader sync complete — ${newBooksCount} new book(s), ${newHighlightsCount} new highlight(s), ${updatedHighlightsCount} updated, ${skippedBooksCount} unchanged skipped`,
          'success'
        );

      } catch (e) {
        console.error('LKRS: sync failed', e);
        logseq.UI.showMsg('KOReader sync failed — check devtools console for details', 'error');
      } finally {
        if (syncProgress) {
          syncProgress.destruct();
        }
        loading = false;
      }
    }
  })

  logseq.App.registerUIItem('toolbar', {
    key: 'koreader-sync',
    template: `
      <a data-on-click="syncKOReader" class="button">
        <i class="ti ti-book"></i>
      </a>
    `
  })
}

logseq.ready(main).catch(console.error)
