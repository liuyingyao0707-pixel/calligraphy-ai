export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const { image, mimeType } = await request.json();

    if (!image) {
      return json({ error: "缺少图片数据" }, 400);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "未配置 GEMINI_API_KEY" }, 500);
    }

    const model = "gemini-2.5-flash";

    const prompt = `你是精通颜体楷书的书法教师。请对这张单字图片做结构评析。

只返回 JSON，不要解释，不要 markdown，不要代码块。

返回格式如下：
{
  "character": "识别到的汉字，无法识别填未识别",
  "totalScore": 0,
  "scores": {
    "结构布局": 0,
    "中宫把握": 0,
    "笔画比例": 0,
    "重心平衡": 0,
    "气韵整体": 0
  },
  "level": "初学/入门/进阶/良好/精熟",
  "summary": "15字内总评",
  "advice": [
    {"level":"good","title":"优点","content":"20字内"},
    {"level":"warn","title":"问题","content":"20字内"}
  ],
  "nextStep": "20字内建议"
}

评分必须拉开层次，不要集中在50—75分之间：
1. 颜真卿原帖单字、高清标准字、结构极为准确者：90—98分；
2. 较高质量临写，结构较准、笔意较足者：80—89分；
3. 一般临写，结构基本可辨但有明显问题者：65—79分；
4. 结构松散、重心失衡、笔力不足较明显者：40—64分；
5. 无法辨识、裁切严重失当、偏离颜体结构明显者：20—39分。

不要保守打分。若判断为颜真卿原帖标准字或高质量碑帖字，应直接给高分。
若图像留白过多、裁切不完整、背景干扰明显，应在summary中指出“图像输入质量影响判断”。
若无法完整判断，相关评分可给50左右。`;

    const first = await callGemini({
      env,
      model,
      mimeType,
      image,
      prompt,
      maxOutputTokens: 4096
    });

    if (first.error) {
      return json({ error: first.error, raw: first.raw || null }, 500);
    }

    if (first.finishReason === "MAX_TOKENS") {
      const shortPrompt = `你是颜体书法教师。请对图片做最短结构评析。

只返回 JSON，不要解释，不要 markdown：
{
  "character": "字",
  "totalScore": 0,
  "scores": {
    "结构布局": 0,
    "中宫把握": 0,
    "笔画比例": 0,
    "重心平衡": 0,
    "气韵整体": 0
  },
  "level": "初学/入门/进阶/良好/精熟",
  "summary": "12字内",
  "advice": [
    {"level":"good","title":"优点","content":"12字内"},
    {"level":"warn","title":"问题","content":"12字内"}
  ],
  "nextStep": "12字内"
}

请拉开分数层次：
原帖标准字 90—98；
较好临写 80—89；
一般临写 65—79；
问题明显 40—64；
无法辨识或图像异常 20—39。`;

      const retry = await callGemini({
        env,
        model,
        mimeType,
        image,
        prompt: shortPrompt,
        maxOutputTokens: 1024
      });

      if (retry.error) {
        return json({ error: retry.error, raw: retry.raw || null }, 500);
      }

      const retryResult = safeParseJson(retry.text);
      if (!retryResult) {
        return json(
          {
            error: "模型输出被截断，简化重试后仍不是有效 JSON",
            raw: retry.text,
            finishReason: retry.finishReason || ""
          },
          500
        );
      }

      return json(retryResult, 200);
    }

    const result = safeParseJson(first.text);

    if (!result) {
      return json(
        {
          error: "模型返回内容不是有效 JSON",
          raw: first.text,
          finishReason: first.finishReason || ""
        },
        500
      );
    }

    return json(result, 200);
  } catch (e) {
    return json(
      {
        error: e.message || "服务器错误"
      },
      500
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: corsHeaders()
  });
}

async function callGemini({ env, model, mimeType, image, prompt, maxOutputTokens }) {
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: mimeType || "image/jpeg",
                    data: image
                  }
                },
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens,
            responseMimeType: "application/json"
          }
        })
      }
    );

    const data = await resp.json();

    if (!resp.ok || data.error) {
      return {
        error: data?.error?.message || "Gemini 调用失败",
        raw: data
      };
    }

    const candidate = data?.candidates?.[0];
    return {
      text: candidate?.content?.parts?.[0]?.text || "",
      finishReason: candidate?.finishReason || ""
    };
  } catch (e) {
    return {
      error: e.message || "Gemini 请求失败"
    };
  }
}

function safeParseJson(text) {
  if (!text) return null;

  let raw = String(text).trim();
  raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  raw = raw.replace(/\s*```$/, "").trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const block = raw.slice(start, end + 1);
    try {
      return JSON.parse(block);
    } catch {}
  }

  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}
