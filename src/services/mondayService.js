const mondaySdk = require('monday-sdk-js');

const monday = mondaySdk();

function buildBoardQuery(includeFiles = true) {
  const fileFields = includeFiles
    ? `
              ... on FileValue {
                files {
                  __typename
                  ... on FileAssetValue {
                    asset_id
                    asset_value_name: name
                    created_at
                    asset {
                      id
                      name
                      url
                      public_url
                      url_thumbnail
                      file_size
                      created_at
                    }
                  }
                  ... on FileLinkValue {
                    file_id
                    link_value_name: name
                    url
                    created_at
                  }
                  ... on FileDocValue {
                    file_id
                    object_id
                    url
                    created_at
                    doc {
                      id
                      object_id
                      name
                      url
                    }
                  }
                  ... on FileAssetInvalidValue {
                    asset_id
                    invalid_value_name: name
                    error
                    created_at
                  }
                }
              }`
    : '';

  return `
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
${fileFields}
            }
          }
         }
      }
    }
  `;
}

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
      const error = new Error(response.errors[0].message);
      error.mondayErrors = response.errors;
      throw error;
    }
    return response.data;
  } catch (err) {
    console.error('Error executing Monday API query:', err);
    throw err;
  }
}

async function getBoardData(token, boardId) {
  let data;
  try {
    data = await executeMondayQuery(token, buildBoardQuery(true), { boardId: parseInt(boardId) });
  } catch (err) {
    if (!isFileQuerySchemaError(err)) {
      throw err;
    }

    console.warn('Monday file column query failed; retrying board query without file details.', err.message);
    data = await executeMondayQuery(token, buildBoardQuery(false), { boardId: parseInt(boardId) });
  }
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
            created_at
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
    id: String(asset.asset?.id || asset.doc?.id || asset.id || asset.asset_id || asset.file_id || asset.object_id || ''),
    name:
      asset.asset?.name ||
      asset.doc?.name ||
      asset.asset_value_name ||
      asset.link_value_name ||
      asset.invalid_value_name ||
      asset.name ||
      'Untitled file',
    url: asset.asset?.public_url || asset.asset?.url || asset.doc?.url || asset.url || asset.public_url || '',
    public_url: asset.asset?.public_url || asset.public_url || '',
    url_thumbnail: asset.asset?.url_thumbnail || asset.url_thumbnail || '',
    file_size: asset.asset?.file_size || asset.file_size || null,
    uploaded_at: asset.asset?.created_at || asset.created_at || asset.uploaded_at || null,
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

function isFileQuerySchemaError(error) {
  const messages = [
    error?.message,
    ...(Array.isArray(error?.mondayErrors) ? error.mondayErrors.map((entry) => entry?.message) : []),
  ]
    .filter(Boolean)
    .map((message) => String(message));

  return messages.some((message) =>
    /Cannot query field .* on type "(FileValueItem|FileAssetValue|FileLinkValue|FileDocValue|FileAssetInvalidValue|Asset|Document)"/.test(message)
    || /Unknown type "(FileValue|FileValueItem|FileAssetValue|FileLinkValue|FileDocValue|FileAssetInvalidValue)"/.test(message)
    || /Fragment cannot be spread here.*File(Value|Asset|Link|Doc)/.test(message)
  );
}

module.exports = {
  executeMondayQuery,
  getBoardData,
  updateItemStatus,
  getItemUpdates,
  createItemUpdate,
  buildBoardQuery,
  normalizeBoardData,
  normalizeAssets,
  normalizeUpdates,
  isFileQuerySchemaError
};
