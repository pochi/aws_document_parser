import ollama from 'ollama';

async function call_model(model: string) {
    const response = await ollama.chat({
        model: model,
        messages: [{ role: 'user', content: 'Why is the sky blue?' }],
    })
    console.log(response.message.content)
}

call_model('phi4-mini:latest');

