const mondaySdk = require('monday-sdk-js');

const monday = mondaySdk();

async function executeMondayQuery(token, query, variables = {}) {
  // Diagnostic logging (masked for security)
  const maskedToken = token ? `${token.substring(0, 4)}...${token.substring(token.length - 4)}` : 'MISSING';
  console.log(`Executing Monday Query with token: ${maskedToken}`);
  console.log(`Query: ${query.substring(0, 100)}...`);

  monday.setToken(token);
  try {
    const response = await monday.api(query, { variables });
    if (response.errors && response.errors.length > 0) {
      console.error('Monday API Errors:', JSON.stringify(response.errors, null, 2));
      throw new Error(response.errors[0].message);
    }
    return response.data;
  } catch (err) {
    console.error('Error executing Monday API query:', err);
    throw err;
  }
}

async function getBoardData(token, boardId) {
  const query = `
    query getBoard($boardId: [ID!]) {
      boards(ids: $boardId) {
         id
         name
         items_page {
          items {
            id
            name
            column_values {
              id
              text
              type
              value
              column {
                title
              }
              ... on FileValue {
                files {
                  id
                  name
                  url
                  public_url
                  url_thumbnail
                  file_size
                  uploaded_at
                }
              }
            }
          }
         }
      }
    }
  `;
  const data = await executeMondayQuery(token, query, { boardId: parseInt(boardId) });
  return normalizeBoardData(data);
}

async function updateItemStatus(token, boardId, itemId, columnId, label) {
  const query = `
    mutation updateStatus($boardId: ID!, $itemId: ID!, $columnId: String!, $label: String!) {
      change_simple_column_value (
        board_id: $boardId,
        item_id: $itemId,
        column_id: $columnId,
        value: $label
      ) {
        id
      }
    }
  `;
  return await executeMondayQuery(token, query, { 
    boardId: parseInt(boardId).toString(), 
    itemId: itemId.toString(), 
    columnId, 
    label 
  });
}

async function getItemUpdates(token, itemId) {
  const query = `
    query getItemUpdates($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        updates(limit: 10) {
          id
          body
          created_at
          creator {
            id
            name
          }
          assets {
            id
            name
            url
            public_url
            url_thumbnail
            file_size
            uploaded_at
          }
        }
      }
    }
  `;

  const data = await executeMondayQuery(token, query, { itemId: itemId.toString() });
  return normalizeUpdates(data?.items?.[0]?.updates || []);
}

async function createItemUpdate(token, itemId, body) {
  const query = `
    mutation createItemUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
        body
        created_at
      }
    }
  `;

  const data = await executeMondayQuery(token, query, {
    itemId: itemId.toString(),
    body,
  });
  return data?.create_update || null;
}

function normalizeBoardData(data) {
  if (!data?.boards) return data;

  return {
    ...data,
    boards: data.boards.map((board) => ({
      ...board,
      items_page: {
        ...(board.items_page || {}),
        items: (board.items_page?.items || []).map((item) => ({
          ...item,
          column_values: (item.column_values || []).map((columnValue) => ({
            id: columnValue.id,
            text: columnValue.text,
            type: columnValue.type,
            value: columnValue.value,
            title: columnValue.column?.title || columnValue.id,
            files: normalizeAssets(columnValue.files || []),
          })),
        })),
      },
    })),
  };
}

function normalizeAssets(assets) {
  return (assets || []).map((asset) => ({
    id: String(asset.id || ''),
    name: asset.name || 'Untitled file',
    url: asset.public_url || asset.url || '',
    public_url: asset.public_url || '',
    url_thumbnail: asset.url_thumbnail || '',
    file_size: asset.file_size || null,
    uploaded_at: asset.uploaded_at || null,
  }));
}

function normalizeUpdates(updates) {
  return (updates || []).map((update) => ({
    id: String(update.id || ''),
    body: update.body || '',
    created_at: update.created_at || null,
    creator: update.creator
      ? {
          id: update.creator.id ? String(update.creator.id) : '',
          name: update.creator.name || 'monday user',
        }
      : null,
    assets: normalizeAssets(update.assets || []),
  }));
}

module.exports = {
  executeMondayQuery,
  getBoardData,
  updateItemStatus,
  getItemUpdates,
  createItemUpdate,
  normalizeBoardData,
  normalizeAssets,
  normalizeUpdates
};
