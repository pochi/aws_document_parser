import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import puppeteer from "puppeteer";
import { existsSync } from 'fs';
import { exit } from 'process';
import { isReadonlyKeywordOrPlusOrMinusToken } from 'typescript';
import { Ollama } from 'ollama';
import { request } from 'http';

// ディレクトリ内のJSONファイルを取得
async function getJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const files = await readdir(dirPath);
    return files
      .filter(file => file.endsWith('.json'))
      .map(file => path.join(dirPath, file));
  } catch (error) {
    console.error(`ディレクトリ読み込みエラー: ${dirPath}`, error);
    return [];
  }
}

async function getJapaneseTranslation(description: string): Promise<string> {
  try {
    const ollama = new Ollama({
      host: 'http://host.docker.internal:11434'
    });

    const response = await ollama.chat({
      model: 'phi4-mini:latest',
      messages: [{ 
        role: 'user', 
        content: `以下を日本語に翻訳してください。${description}`
      }]
    });
    
    // 正しいレスポンスの取得方法
    return response.message?.content || '翻訳に失敗しました';
  } catch (error) {
    console.error('翻訳エラー:', error);
    return description; // エラー時は元のテキストを返す
  }
}

// JSON を CSV に変換
async function jsonToCsv(jsonData: any[]): Promise<string[]> {
  const row = [];
  try {
    row.push(jsonData['serviceName']);
    row.push(jsonData['apiName']);
    row.push(jsonData['url']);
    row.push(jsonData['description']);
    // const description_jpn = await getJapaneseTranslation(jsonData['description']);
    // row.push(description_jpn);
    const requestSyntax = await parseRequestSyntax(jsonData['requestSyntax']);
    //console.log(requestSyntax);
    row.push(requestSyntax['method']);
    row.push(requestSyntax['headers']);
    row.push(requestSyntax['url']);
    row.push(requestSyntax['params']);
    row.push(requestSyntax['body']);
    const requestBody = await parseResponseElement(jsonData['requestBody']);
    //console.log(requestBody);
    row.push(requestBody);
    const responseSyntax = await parseResponseSyntax(jsonData['responseSyntax']);
    //console.log(responseSyntax);
    row.push(responseSyntax['http_version']);
    row.push(responseSyntax['status_code']);
    row.push(responseSyntax['headers']);
    row.push(responseSyntax['body']);
    const responseElement = await parseResponseElement(jsonData['responseElements']);
    //console.log(responseElement);
    row.push(responseElement);
    const errorList = await parseResponseElement(jsonData['errors']);
    //console.log(errorList);
    row.push(errorList);
  } catch(error) {
    console.error(`CSVパースエラー: ${jsonData['apiName']} ${jsonData['url']}`);
    console.error(error);
    exit(0);
  }

  // console.log(row);
  return row;
}

async function parseResponseSyntax(html: string): Promise<Record<string, string>> {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setContent(html);
  
  // レスポンス構文を取得（複数のセレクタを試す）
  let codeText = '';
  try {
    codeText = await page.$eval('pre.programlisting code, div.programlisting code, pre code', 
      (el) => el.textContent?.trim() || '');
  } catch (error) {
    console.warn('Failed to find code block with standard selectors, trying fallback...');
    // フォールバック: すべてのpre要素から探す
    const preElements = await page.$$('pre');
    for (const pre of preElements) {
      const text = await pre.evaluate(el => el.textContent?.trim() || '');
      if (text.includes('HTTP/') || text.includes('{')) {
        codeText = text;
        break;
      }
    }
  }

  // コードブロックが見つからない場合の処理
  if (!codeText) {
    await browser.close();
    return {
      "http_version": "",
      "status_code": "",
      "headers": "{}",
      "body": "",
      "error": "Response syntax not found"
    };
  }

  // レスポンスの各部分を抽出
  let httpVersion = '';
  let statusCode = '';
  let headersObj: Record<string, string> = {};
  let body = '';

  const lines = codeText.split('\n');
  
  // HTTPステータスラインの有無を確認
  if (lines[0].startsWith('HTTP/')) {
    const [httpVer, status, ..._] = lines[0].split(' ');
    httpVersion = httpVer;
    statusCode = status;

    // ヘッダーとボディを分離
    const restLines = lines.slice(1);
    const emptyLineIndex = restLines.findIndex(line => line.trim() === '');
    const headers = emptyLineIndex >= 0 ? restLines.slice(0, emptyLineIndex) : [];
    const bodyLines = emptyLineIndex >= 0 ? restLines.slice(emptyLineIndex + 1) : restLines;
    body = bodyLines.join('\n').trim();

    // ヘッダーをオブジェクトに変換
    headers.forEach(header => {
      const separatorIndex = header.indexOf(':');
      if (separatorIndex > 0) {
        const key = header.slice(0, separatorIndex).trim();
        const value = header.slice(separatorIndex + 1).trim();
        headersObj[key] = value;
      }
    });
  } else {
    // ステータスラインがない場合はボディのみとみなす
    body = codeText.trim();
  }

  await browser.close();

  return {
    "http_version": httpVersion,
    "status_code": statusCode,
    "headers": JSON.stringify(headersObj),
    "body": body,
  };
}

async function parseResponseElement(html: string): Promise<string> {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setContent(html);

  // レスポンス構造情報を抽出
  const responseStructure = await page.$$eval('.variablelist dl', (dlElements) => {
    return dlElements.map(dl => {
      const items = [];
      const dtElements = dl.querySelectorAll('dt');
      const ddElements = dl.querySelectorAll('dd');
      
      dtElements.forEach((dt, index) => {
        const term = dt.querySelector('.term a')?.textContent?.trim() || '';
        const dd = ddElements[index]?.textContent?.trim() || '';
        
        items.push({
          parameter: term,
          description: dd.replace(/\n/g, ' ').replace(/\s+/g, ' ') // 改行と余分なスペースを除去
        });
      });
      
      return items;
    });
  });

  // console.log('Response Structure:', JSON.stringify(responseStructure, null, 2));

  await browser.close();

  return JSON.stringify(responseStructure);
}

async function parseRequestSyntax(html: string): Promise<Record<string, string>> {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setContent(html);
  let codeText = '';
  try {
    codeText = await page.$eval('pre.programlisting code', (el) => el.textContent.trim());
  } catch(error) {
    // 上記が取れないときはRequest Syntaxがそもそも取れていない
    return {
      "method": '',
      "http_version": '',
      "headers": '',
      "url": '',
      "params": '',
      "body": ''
    };
  }

  let method = '';
  let url = '';
  let fullUrl = '';
  let httpVersion = '';
  let params: Record<string, string> = {};
  let headersObj: Record<string, string> = {};
  let body = '';

  const lines = codeText.split('\n');
  const firstLineParts = lines[0].trim().split(' ');

  // リクエストラインの有無を判定
  const isRequestLine = firstLineParts.length >= 3 && 
                       ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(firstLineParts[0]);

  if (isRequestLine) {
    // リクエストラインがある場合
    [method, fullUrl, httpVersion] = firstLineParts;

    // URLとクエリパラメータを分離
    const [baseUrl, queryString] = fullUrl.split('?');
    url = baseUrl;

    // クエリパラメータを解析
    if (queryString) {
      queryString.split('&').forEach(pair => {
        const [key, value] = pair.split('=');
        if (key) params[key] = decodeURIComponent(value || '');
      });
    }

    // ヘッダーとボディを分離
    const restLines = lines.slice(1);
    const emptyLineIndex = restLines.findIndex(line => line.trim() === '');
    const headers = emptyLineIndex >= 0 ? restLines.slice(0, emptyLineIndex) : [];
    const bodyLines = emptyLineIndex >= 0 ? restLines.slice(emptyLineIndex + 1) : [];
    body = bodyLines.join('\n').trim();

    // ヘッダーをオブジェクトに変換
    headers.forEach(header => {
      const separatorIndex = header.indexOf(':');
      if (separatorIndex > 0) {
        const key = header.slice(0, separatorIndex).trim();
        const value = header.slice(separatorIndex + 1).trim();
        headersObj[key] = value;
      }
    });
  } else {
    // リクエストラインがない場合（ボディのみ）
    body = lines.join('\n').trim();
  }

  await browser.close();

  return {
    "method": method,
    "http_version": httpVersion,
    "headers": JSON.stringify(headersObj),
    "url": url,
    "params": JSON.stringify(params),
    "body": body
  };
}

async function parseError(html: string): Promise<string> {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setContent(html);

  // エラー情報を抽出
  const errorList = await page.$$eval('.variablelist dl', (dlElements) => {
    return dlElements.flatMap(dl => {
      const errors = [];
      const dtElements = dl.querySelectorAll('dt');
      const ddElements = dl.querySelectorAll('dd');
      
      dtElements.forEach((dt, index) => {
        const errorName = dt.querySelector('.term b')?.textContent?.trim() || '';
        const ddText = ddElements[index]?.textContent?.trim() || '';
        
        // 説明文とステータスコードを分離
        const description = ddText.replace(/HTTP Status Code: \d+/g, '').trim();
        const statusCodeMatch = ddText.match(/HTTP Status Code: (\d+)/);
        const statusCode = statusCodeMatch ? statusCodeMatch[1] : '';
        
        errors.push({
          error: errorName,
          status_code: statusCode,
          description: description.replace(/\s+/g, ' ') // 連続するスペースを単一に
        });
      });
      
      return errors;
    });
  });

  // console.log('Error List:', JSON.stringify(errorList, null, 2));

  await browser.close();

  return JSON.stringify(errorList);
}

async function saveToCsv(rows: any[], outputDir: string) {
  // CSVヘッダーを定義
  const headers = [
    'ActionGroup',
    'API Name',
    'API Reference URL',
    'description',
    // 'description(jpn)',
    'HTTP Method',
    'Request Headers',
    'Endpoint',
    'Query Parameters',
    'Request Body',
    'Request Parameters Description',
    'HTTP Version',
    'Success Status Code',
    'Response Headers',
    'Success Response Body',
    'Success Response Parameters Description',
    'Error Responses'
  ];

  // データをCSV形式に変換
  const csvRows = rows.map(row => {
    // 各フィールドの改行とダブルクォートを処理
    return row.map((field: string) => {
      // ダブルクォートをエスケープ
      let escaped = field.replace(/"/g, '""');
      // 改行やカンマが含まれる場合はダブルクォートで囲む
      if (escaped.includes('\n') || escaped.includes(',')) {
        escaped = `"${escaped}"`;
      }
      return escaped;
    }).join(',');
  });

  // ヘッダーとデータを結合
  const csvContent = [
    headers.join(','),
    ...csvRows
  ].join('\n');

  const csvFileName = 'api_list.csv';
  const csvFilePath = path.join(outputDir, csvFileName);

  await writeFile(csvFilePath, csvContent, 'utf-8');
  console.log(`CSVファイルを生成: ${csvFilePath}`);
}

async function createCsvDetails() {
  const inputDir = path.join(process.cwd(), 'output', 'api_details');
  const outputDir = path.join(process.cwd(), 'output', 'csv_details');

  // 出力ディレクトリがなければ作成
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  const jsonFiles = await getJsonFiles(inputDir);
  const rows = []
  for (const jsonFile of jsonFiles) {
    try {
      const jsonData = JSON.parse(await readFile(jsonFile, 'utf-8'));
      // console.log(jsonData);
      const row = await jsonToCsv(jsonData);
      rows.push(row);
    } catch (error) {
      console.error(`ファイル処理エラー: ${jsonFile}`, error);
      exit(0);
    }
  }

  saveToCsv(rows, outputDir).catch(console.error);
}

createCsvDetails().catch(console.error);