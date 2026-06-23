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
          })),
        })),
      },
    })),
  };
}

module.exports = {
  executeMondayQuery,
  getBoardData,
  updateItemStatus,
  normalizeBoardData
};
