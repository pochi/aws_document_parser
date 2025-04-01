import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import puppeteer from "puppeteer";
import { existsSync } from 'fs';

interface ApiOperation {
  name: string;
  link: string;
}

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

// 単一JSONファイルを読み込み
async function readJsonFile(filePath: string): Promise<ApiOperation[]> {
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as ApiOperation[];
  } catch (error) {
    console.error(`ファイル読み込みエラー: ${filePath}`, error);
    return [];
  }
}

// 結果を保存
async function saveResult(apiName: string, data: any): Promise<void> {
  const resultDir = path.join(process.cwd(), 'output', 'api_details');
  
  // ディレクトリが存在しない場合は作成
  if (!existsSync(resultDir)) {
    await mkdir(resultDir, { recursive: true });
  }
  
  const filePath = path.join(resultDir, `${apiName}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`    → ${apiName} の詳細を保存しました: ${filePath}`);
}

// メイン処理
async function processAllApiFiles() {
  const dirPath = path.join(process.cwd(), 'output', 'api_list');
  const jsonFiles = await getJsonFiles(dirPath);
  
  if (jsonFiles.length === 0) {
    console.log('処理対象のJSONファイルが見つかりませんでした');
    return;
  }

  console.log(`処理開始: ${jsonFiles.length}個のファイルを検出`);

  // ファイルを順番に処理
  for (const [index, filePath] of jsonFiles.entries()) {
    console.log(`\n[${index + 1}/${jsonFiles.length}] 処理中: ${path.basename(filePath)}`);
    
    const operations = await readJsonFile(filePath);
    console.log(`  → 読み込んだ操作件数: ${operations.length}`);
    
    // ここで各ファイルのデータに対する処理を実行
    await processOperations(operations);
  }

  console.log('\nすべてのファイル処理が完了しました');
}

async function scrapeAWSDocs(url: string) {
  console.log(`    スクレイピング開始: ${url}`);
  
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();

    // ユーザーエージェントを設定
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36');
    
    // タイムアウトを設定
    page.setDefaultNavigationTimeout(60000);
    
    // AWS Bedrock APIドキュメントページにアクセス
    console.log(`    URL: ${url}に移動中...`);
    await page.goto(url, {
      waitUntil: 'networkidle0' // ページが完全にロードされるまで待機
    });

    // 少し待機してJS実行を待つ
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('    ページロード完了');
    
    // デバッグ用にスクリーンショットを撮影
    const screenshotPath = `screenshot_${new Date().getTime()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`    デバッグ用スクリーンショットを保存しました: ${screenshotPath}`);
    
    // URL最後のコンポーネントからAPI名を抽出
    const urlParts = url.split('/');
    const lastUrlPart = urlParts[urlParts.length - 1];
    const apiNameFromUrl = lastUrlPart.replace('API_', '').replace('.html', '');
    
    // ページからAPI名を取得（バックアップメソッド）
    const apiNameFromPage = await page.evaluate(() => {
      const title = document.querySelector('title');
      if (title) {
        const titleText = title.textContent;
        const apiNameMatch = titleText?.match(/API_(\w+)/);
        if (apiNameMatch && apiNameMatch[1]) {
          return apiNameMatch[1];
        }
      }
      
      const h1 = document.querySelector('h1.topictitle1');
      return h1 ? h1.textContent.trim() : '';
    });
    
    const apiName = apiNameFromPage || apiNameFromUrl || 'unknown_api';
    console.log(`    API名: ${apiName}`);

    // ページ内容全体を取得
    const pageContent = await page.content();
    
    // 直接DOM操作で各セクションを取得
    const result = await page.evaluate(() => {
      // 返すデータのオブジェクト
      const data = {
        requestSyntax: '',
        requestParameters: '',
        requestBody: '',
        responseSyntax: '',
        responseElements: '',
        errors: '',
        rawSections: {} // デバッグ用の生データ
      };
      
      // ページ内のすべてのh2要素を取得
      const headings = Array.from(document.querySelectorAll('h2, h3'));
      console.log('--------------------------');
      console.log(headings)
      
      // 各見出しを処理
      headings.forEach(heading => {
        const headingText = heading.textContent.trim();
        data.rawSections[headingText] = '見出し検出';
        
        // セクション内容を取得（現在の見出しから次の見出しまで）
        function getSectionContent(element) {
          let content = '';
          let current = element.nextElementSibling;
          
          while (current && !['H1', 'H2', 'H3'].includes(current.tagName)) {
            content += current.outerHTML;
            current = current.nextElementSibling;
          }
          
          return content;
        }
        
        // 見出しのテキストに基づいてセクションを特定
        if (headingText.includes('Request Syntax')) {
          data.requestSyntax = getSectionContent(heading);
          data.rawSections[headingText] = 'コンテンツ取得: Request Syntax';
        } 
        else if (headingText.includes('Request Parameters')) {
          data.requestParameters = getSectionContent(heading);
          data.rawSections[headingText] = 'コンテンツ取得: Request Parameters';
        }
        else if (headingText.includes('Request Body')) {
          data.requestBody = getSectionContent(heading);
          data.rawSections[headingText] = 'コンテンツ取得: Request Body';
        }
        else if (headingText.includes('Response Syntax')) {
          data.responseSyntax = getSectionContent(heading);
          data.rawSections[headingText] = 'コンテンツ取得: Response Syntax';
        }
        else if (headingText.includes('Response Elements')) {
          data.responseElements = getSectionContent(heading);
          data.rawSections[headingText] = 'コンテンツ取得: Response Elements';
        }
        else if (headingText === 'Errors') {
          data.errors = getSectionContent(heading);
          data.rawSections[headingText] = 'コンテンツ取得: Errors';
        }
      });
      
      // ページ全体の見出し構造を記録（デバッグ用）
      data.headingStructure = headings.map(h => ({
        tag: h.tagName,
        text: h.textContent.trim(),
        id: h.id || 'no-id'
      }));
      
      return data;
    });
    
    // コンテンツの有無をチェック
    let contentFound = false;
    for (const key of ['requestSyntax', 'requestParameters', 'requestBody', 'responseSyntax', 'responseElements', 'errors']) {
      if (result[key] && result[key].length > 0) {
        contentFound = true;
        break;
      }
    }
    
    // コンテンツが見つからない場合は代替手段でデータを取得
    if (!contentFound) {
      console.log('    通常の方法でコンテンツが見つかりませんでした。代替手段を試行します...');
      
      // ページからすべてのDIVを取得し構造を分析
      const alternativeResult = await page.evaluate(() => {
        const data = {
          sections: {},
          divTree: []
        };
        
        // すべてのdiv要素を取得
        const divs = Array.from(document.querySelectorAll('div'));
        
        // 各divの情報を収集
        divs.forEach((div, index) => {
          // 15個以上の子要素を持つdivのみ対象
          if (div.children.length >= 15) {
            const childTypes = Array.from(div.children).map(c => c.tagName);
            
            // 各divの情報を記録
            data.divTree.push({
              index,
              id: div.id || 'no-id',
              className: div.className,
              childCount: div.children.length,
              childTypes: childTypes,
              textPreview: div.textContent.substring(0, 100) + '...'
            });
            
            // テキスト内容に基づいてセクションを検出
            const text = div.textContent.toLowerCase();
            if (text.includes('request syntax')) {
              data.sections.requestSyntax = div.outerHTML;
            }
            else if (text.includes('request parameters')) {
              data.sections.requestParameters = div.outerHTML;
            }
            else if (text.includes('request body')) {
              data.sections.requestBody = div.outerHTML;
            }
            else if (text.includes('response syntax')) {
              data.sections.responseSyntax = div.outerHTML;
            }
            else if (text.includes('response elements')) {
              data.sections.responseElements = div.outerHTML;
            }
            else if (text.includes('errors') && text.length < 300) {
              data.sections.errors = div.outerHTML;
            }
          }
        });
        
        return data;
      });
      
      // 見つかったセクションをマージ
      for (const [key, value] of Object.entries(alternativeResult.sections)) {
        if (value && typeof value === 'string' && value.length > 0) {
          result[key] = value;
        }
      }
      
      // div構造をデバッグデータに追加
      result.divTree = alternativeResult.divTree;
    }
    
    // ファイル名から抽出したAPIの実際の名前
    const matches = url.match(/API_([^\.]+)\.html/);
    const apiNameFromFileName = matches ? matches[1] : '';
    
    // 最終的な結果をフォーマット
    const formattedResult = {
      apiName: apiName,
      apiNameFromUrl: apiNameFromUrl,
      apiNameFromFile: apiNameFromFileName,
      url: url,
      requestSyntax: result.requestSyntax || "Not found",
      requestParameters: result.requestParameters || "Not found",
      requestBody: result.requestBody || "Not found",
      responseSyntax: result.responseSyntax || "Not found",
      responseElements: result.responseElements || "Not found",
      errors: result.errors || "Not found",
      debugInfo: {
        rawSections: result.rawSections,
        headingStructure: result.headingStructure,
        divTree: result.divTree
      }
    };
    
    console.log('    データ取得完了');
    return { apiName: apiNameFromFileName || apiName, result: formattedResult };
  } catch (error) {
    console.error('    スクレイピングエラー:', error);
    throw error;
  } finally {
    // ブラウザを閉じる前に少し待機
    await new Promise(resolve => setTimeout(resolve, 1000));
    await browser.close();
    console.log('    ブラウザを閉じました');
  }
}

async function processOperations(operations: ApiOperation[]) {
  // 並列処理の制限（1つに制限）
  const concurrencyLimit = 1;
  const chunks = [];
  
  // 操作リストをチャンクに分割
  for (let i = 0; i < operations.length; i += concurrencyLimit) {
    chunks.push(operations.slice(i, i + concurrencyLimit));
  }
  
  // チャンクごとに処理
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (op) => {
      console.log(`    - 処理中: ${op.name}`);
      try {
        console.log(op.link);
        const { apiName, result } = await scrapeAWSDocs(op.link);
        // 結果を保存
        await saveResult(apiName || op.name, result);
      } catch (err) {
        console.error(`    - ${op.name}の処理中にエラーが発生しました:`, err);
      }
    }));
    
    // レート制限を回避するための遅延
    if (chunks.indexOf(chunk) < chunks.length - 1) {
      console.log('    次のバッチ処理前に待機中...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

// 単一のURLをテストする関数
async function testSingleUrl(url: string) {
  console.log(`単一URLのテスト開始: ${url}`);
  try {
    const { apiName, result } = await scrapeAWSDocs(url);
    await saveResult(`${apiName || 'unknown_api'}`, result);
    console.log('テスト完了');
  } catch (err) {
    console.error('テスト中にエラーが発生しました:', err);
  }
}

// コマンドライン引数を解析
const args = process.argv.slice(2);
if (args.length > 0 && args[0].startsWith('http')) {
  // URLが指定された場合は単一URLのテスト
  testSingleUrl(args[0]).catch(console.error);
} else {
  // 引数がない場合は通常の処理を実行
  processAllApiFiles().catch(console.error);
}