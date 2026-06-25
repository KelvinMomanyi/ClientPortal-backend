const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBoardQuery,
  buildNextItemsPageQuery,
  getItemsPageLimit,
  getMaxBoardPages,
  isFileQuerySchemaError,
  normalizeAssets,
  normalizeBoardData,
  normalizeUpdates,
} = require('../src/services/mondayService');

test('normalizeBoardData exposes Monday file column assets to the client payload', () => {
  const normalized = normalizeBoardData({
    boards: [
      {
        id: '10',
        name: 'Client Board',
        items_page: {
          items: [
            {
              id: '100',
              name: 'Deliverable',
              column_values: [
                {
                  id: 'files',
                  text: '',
                  type: 'file',
                  value: null,
                  column: { title: 'Client files' },
                  files: [
                    {
                      __typename: 'FileAssetValue',
                      asset_id: 500,
                      asset_value_name: 'Original file name',
                      created_at: '2026-06-24T09:00:00Z',
                      asset: {
                        id: 500,
                        name: 'Brief.pdf',
                        url: 'https://signed.example/file',
                        public_url: 'https://public.example/file',
                        url_thumbnail: 'https://public.example/thumb',
                        file_size: 2048,
                        created_at: '2026-06-24T10:00:00Z',
                      },
                    },
                    {
                      __typename: 'FileLinkValue',
                      file_id: 'link-1',
                      link_value_name: 'Reference link',
                      url: 'https://example.com/reference',
                      created_at: '2026-06-24T11:00:00Z',
                    },
                    {
                      __typename: 'FileDocValue',
                      file_id: 'doc-file-1',
                      object_id: 'doc-object-1',
                      url: 'https://monday.com/docs/doc-object-1',
                      created_at: '2026-06-24T12:00:00Z',
                      doc: {
                        id: 'doc-1',
                        object_id: 'doc-object-1',
                        name: 'Project doc',
                        url: 'https://monday.com/docs/doc-1',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  });

  const fileColumn = normalized.boards[0].items_page.items[0].column_values[0];
  assert.equal(fileColumn.title, 'Client files');
  assert.deepEqual(fileColumn.files, [
    {
      id: '500',
      name: 'Brief.pdf',
      url: 'https://public.example/file',
      public_url: 'https://public.example/file',
      url_thumbnail: 'https://public.example/thumb',
      file_size: 2048,
      uploaded_at: '2026-06-24T10:00:00Z',
    },
    {
      id: 'link-1',
      name: 'Reference link',
      url: 'https://example.com/reference',
      public_url: '',
      url_thumbnail: '',
      file_size: null,
      uploaded_at: '2026-06-24T11:00:00Z',
    },
    {
      id: 'doc-1',
      name: 'Project doc',
      url: 'https://monday.com/docs/doc-1',
      public_url: '',
      url_thumbnail: '',
      file_size: null,
      uploaded_at: '2026-06-24T12:00:00Z',
    },
  ]);
});

test('normalizeAssets falls back to signed URLs and safe file defaults', () => {
  assert.deepEqual(
    normalizeAssets([
      { id: 9, url: 'https://signed.example/asset' },
      { id: 10, name: 'Preview.png', public_url: 'https://public.example/asset' },
    ]),
    [
      {
        id: '9',
        name: 'Untitled file',
        url: 'https://signed.example/asset',
        public_url: '',
        url_thumbnail: '',
        file_size: null,
        uploaded_at: null,
      },
      {
        id: '10',
        name: 'Preview.png',
        url: 'https://public.example/asset',
        public_url: 'https://public.example/asset',
        url_thumbnail: '',
        file_size: null,
        uploaded_at: null,
      },
    ]
  );
});

test('normalizeUpdates includes creators and update attachment assets', () => {
  const updates = normalizeUpdates([
    {
      id: 700,
      body: '<p>Ready for review</p>',
      created_at: '2026-06-24T11:00:00Z',
      creator: { id: 30, name: 'Project Lead' },
      assets: [{ id: 55, name: 'Review.docx', public_url: 'https://public.example/review' }],
    },
  ]);

  assert.deepEqual(updates, [
    {
      id: '700',
      body: '<p>Ready for review</p>',
      created_at: '2026-06-24T11:00:00Z',
      creator: { id: '30', name: 'Project Lead' },
      assets: [
        {
          id: '55',
          name: 'Review.docx',
          url: 'https://public.example/review',
          public_url: 'https://public.example/review',
          url_thumbnail: '',
          file_size: null,
          uploaded_at: null,
        },
      ],
    },
  ]);
});

test('buildBoardQuery can omit optional file fragments for schema fallback', () => {
  const queryWithFiles = buildBoardQuery(true);
  const queryWithoutFiles = buildBoardQuery(false);

  assert.match(queryWithFiles, /items_page\(limit: \$limit\)/);
  assert.match(queryWithFiles, /\$limit: Int!/);
  assert.match(queryWithFiles, /FileAssetValue/);
  assert.match(queryWithFiles, /asset_value_name: name/);
  assert.match(queryWithFiles, /FileLinkValue/);
  assert.match(queryWithFiles, /link_value_name: name/);
  assert.match(queryWithFiles, /FileDocValue/);
  assert.match(queryWithFiles, /invalid_value_name: name/);
  assert.doesNotMatch(queryWithoutFiles, /FileAssetValue/);
  assert.doesNotMatch(queryWithoutFiles, /files\s*\{/);
  assert.match(queryWithoutFiles, /column_values/);
});

test('buildNextItemsPageQuery uses cursor pagination for large boards', () => {
  const query = buildNextItemsPageQuery(false);

  assert.match(query, /next_items_page\(cursor: \$cursor\)/);
  assert.match(query, /cursor/);
  assert.match(query, /items/);
  assert.doesNotMatch(query, /FileAssetValue/);
});

test('Monday pagination limits are bounded for review-safe board loading', () => {
  const oldLimit = process.env.MONDAY_ITEMS_PAGE_LIMIT;
  const oldPages = process.env.MONDAY_MAX_BOARD_PAGES;
  process.env.MONDAY_ITEMS_PAGE_LIMIT = '9999';
  process.env.MONDAY_MAX_BOARD_PAGES = '9999';

  assert.equal(getItemsPageLimit(), 500);
  assert.equal(getMaxBoardPages(), 100);

  if (oldLimit === undefined) {
    delete process.env.MONDAY_ITEMS_PAGE_LIMIT;
  } else {
    process.env.MONDAY_ITEMS_PAGE_LIMIT = oldLimit;
  }

  if (oldPages === undefined) {
    delete process.env.MONDAY_MAX_BOARD_PAGES;
  } else {
    process.env.MONDAY_MAX_BOARD_PAGES = oldPages;
  }
});

test('isFileQuerySchemaError identifies Monday file fragment schema errors only', () => {
  const error = new Error('Cannot query field "id" on type "FileValueItem".');
  error.mondayErrors = [
    { message: 'Cannot query field "name" on type "FileValueItem".' },
  ];

  assert.equal(isFileQuerySchemaError(error), true);
  assert.equal(isFileQuerySchemaError(new Error('User unauthorized')), false);
});
