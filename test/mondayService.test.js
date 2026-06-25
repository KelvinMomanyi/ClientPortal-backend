const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
                      id: 500,
                      name: 'Brief.pdf',
                      url: 'https://signed.example/file',
                      public_url: 'https://public.example/file',
                      url_thumbnail: 'https://public.example/thumb',
                      file_size: 2048,
                      uploaded_at: '2026-06-24T10:00:00Z',
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
