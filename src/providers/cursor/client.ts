import { getCursorCredentials, refreshAccessToken, type CursorCredentials } from './credentials';

export interface BillingRow {
  date: Date;
  user: string;
  kind: string;
  model: string;
  maxMode: string;
  inputWithCache: number | null;
  inputWithoutCache: number | null;
  cacheRead: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
}

export interface FetchBillingResult {
  success: boolean;
  rows?: BillingRow[];
  error?: string;
}

const BILLING_API_URL = 'https://cursor.com/api/dashboard/export-usage-events-csv';

function parseCsvContent(content: string): BillingRow[] {
  const lines = content.split('\n').filter(line => line.trim());
  const rows: BillingRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);

    if (fields.length < 10) continue;

    const parseNum = (s: string): number | null => {
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };

    const dateStr = fields[0]!.trim();
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    rows.push({
      date,
      user: '',
      kind: fields[1]!,
      model: fields[2]!,
      maxMode: fields[3]!,
      inputWithCache: parseNum(fields[4]!),
      inputWithoutCache: parseNum(fields[5]!),
      cacheRead: parseNum(fields[6]!),
      outputTokens: parseNum(fields[7]!),
      totalTokens: parseNum(fields[8]!),
      cost: parseNum(fields[9]!),
    });
  }

  return rows;
}

function createSessionToken(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf-8'));
    const sub = payload.sub as string;
    if (!sub) return null;
    
    const userId = sub.split('|')[1];
    if (!userId) return null;
    
    return `${userId}%3A%3A${accessToken}`;
  } catch {
    return null;
  }
}

async function fetchWithToken(url: URL, accessToken: string): Promise<Response> {
  const sessionToken = createSessionToken(accessToken);
  
  if (!sessionToken) {
    return fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'text/csv',
      },
    });
  }

  return fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Cookie': `WorkosCursorSessionToken=${sessionToken}`,
      'Accept': 'text/csv',
    },
  });
}

export async function fetchBillingData(
  startDate: Date,
  endDate: Date,
  credentials?: CursorCredentials
): Promise<FetchBillingResult> {
  const creds = credentials ?? getCursorCredentials();

  if (!creds) {
    return {
      success: false,
      error: 'No Cursor credentials found. Please log in to Cursor first.',
    };
  }

  const url = new URL(BILLING_API_URL);
  url.searchParams.set('startDate', startDate.getTime().toString());
  url.searchParams.set('endDate', endDate.getTime().toString());
  url.searchParams.set('strategy', 'tokens');

  try {
    let response = await fetchWithToken(url, creds.accessToken);

    if (response.status === 401 && creds.refreshToken) {
      const refreshResult = await refreshAccessToken(creds.refreshToken);
      if (refreshResult.success && refreshResult.credentials) {
        response = await fetchWithToken(url, refreshResult.credentials.accessToken);
      } else {
        return {
          success: false,
          error: refreshResult.error || 'Cursor authentication expired. Please re-login to Cursor.',
        };
      }
    }

    if (response.status === 401) {
      return {
        success: false,
        error: 'Cursor authentication expired. Please re-login to Cursor.',
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        error: `API request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`,
      };
    }

    const csvContent = await response.text();
    const rows = parseCsvContent(csvContent);

    return {
      success: true,
      rows,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error fetching billing data',
    };
  }
}

export function getDefaultDateRange(): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);

  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);
  startDate.setHours(0, 0, 0, 0);

  return { startDate, endDate };
}
