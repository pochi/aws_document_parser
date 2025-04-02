import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import puppeteer from "puppeteer";
import { existsSync } from 'fs';
import { exit } from 'process';
import { isReadonlyKeywordOrPlusOrMinusToken } from 'typescript';

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

// JSON を CSV に変換
async function jsonToCsv(jsonData: any[], group: string): Promise<string[]> {
  const row = [];
  try {
    row.push(group);
    row.push(jsonData['apiName']);
    row.push(jsonData['url']);
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
    // exit(0);
  }

  return row;
}

async function parseResponseSyntax(html: string): Promise<Record<string, string>> {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setContent(html);
  const codeText = await page.$eval('pre.programlisting code', (el) => el.textContent.trim());

  // レスポンスの各部分を抽出
  const [statusLine, ...restLines] = codeText.split('\n');
  const [httpVersion, statusCode] = statusLine.split(' ');

  // ヘッダーとボディを分離
  const emptyLineIndex = restLines.findIndex(line => line.trim() === '');
  const headers = restLines.slice(0, emptyLineIndex);
  const bodyLines = restLines.slice(emptyLineIndex + 1);
  const body = bodyLines.join('\n').trim();

  // ヘッダーをオブジェクトに変換
  const headersObj: Record<string, string> = {};
  headers.forEach(header => {
    const [key, value] = header.split(':').map(s => s.trim());
    if (key && value) headersObj[key] = value;
  });

  // 結果を表示
  // console.log('HTTP Version:', httpVersion); // "HTTP/1.1"
  // console.log('Status Code:', statusCode);  // "202"
  // console.log('Headers:', headersObj);      // { "Content-type": "application/json" }
  // console.log('Body:', body);              // JSON形式のレスポンスボディ

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
  const codeText = await page.$eval('pre.programlisting code', (el) => el.textContent.trim());

  // リクエストの各部分を抽出
  const [requestLine, ...restLines] = codeText.split('\n');
  const [method, fullUrl, _httpVersion] = requestLine.split(' ');

  // URLとクエリパラメータを分離
  const [url, queryString] = fullUrl.split('?');
  
  // クエリパラメータを解析
  const params: Record<string, string> = {};
  if (queryString) {
    queryString.split('&').forEach(pair => {
      const [key, value] = pair.split('=');
      params[key] = decodeURIComponent(value);
    });
  }

  // ヘッダーとボディを分離
  const emptyLineIndex = restLines.findIndex(line => line.trim() === '');
  const headers = restLines.slice(0, emptyLineIndex);
  const bodyLines = restLines.slice(emptyLineIndex + 1);
  const body = bodyLines.join('\n').trim();

  // ヘッダーをオブジェクトに変換
  const headersObj: Record<string, string> = {};
  headers.forEach(header => {
    const [key, value] = header.split(':').map(s => s.trim());
    if (key && value) headersObj[key] = value;
  });

  await browser.close();
  return {
    "method": method,
    "headers": JSON.stringify(headersObj),
    "url": url,
    "params": JSON.stringify(params),
    "body": body,
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

function detectGroup(filename: string, url: string): string {
  const detect_groups = filename.split(/[_-]/);
  try {
    if (detect_groups[0] == 'agent-runtime') {
      return 'agent-runtime';
    }
  
    if (detect_groups[0] == 'agent') {
      return 'agent';
    }

    if (detect_groups[0] == 'runtime') {
      return 'bedrock-runtime';
    }

    if (url.includes('AmazonS3')) {
      return 'AmazonS3';
    }

    if (url.includes('opensearch')) {
      return 'opensearch';
    }

  } finally {
    return 'bedrock';
  }

  return 'bedrock';
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
      const group = detectGroup(jsonFile, jsonData['url']);
      // console.log(jsonData);
      const row = await jsonToCsv(jsonData, group);
      rows.push(row);
    } catch (error) {
      console.error(`ファイル処理エラー: ${jsonFile}`, error);
      exit(0);
    }
  }

  saveToCsv(rows, outputDir).catch(console.error);
}

createCsvDetails().catch(console.error);