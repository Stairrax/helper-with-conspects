# Свой хостинг и устройство кода

[← к описанию](../README.md)

Приложение уже работает по адресу https://stairrax.github.io/helper-with-conspects/ — свой хостинг нужен, только если хотите менять код или держать свою копию.

## Как разместить свою копию

Микрофону и установке PWA нужен **HTTPS**, поэтому файл нельзя просто открыть с диска телефона — разместите папку на бесплатном хостинге.

**GitHub Pages**
1. Загрузите файлы репозитория в GitHub-репозиторий.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, выберите ветку и папку `/ (root)`, **Save**.
3. Через минуту приложение будет доступно по адресу `https://<логин>.github.io/<репозиторий>/`.

**Netlify**
1. Зайдите на [app.netlify.com/drop](https://app.netlify.com/drop).
2. Перетащите папку с файлами (`index.html`, `manifest.webmanifest`, `sw.js`, `css/`, `js/`, `icons/`, `fonts/`, `voices/`).
3. Netlify выдаст адрес `https://….netlify.app`.

Откройте адрес в **Chrome на Android**, разрешите доступ к микрофону при первой диктовке. Для компьютера можно запустить локально: `npx http-server .` и открыть `http://localhost:8080` (localhost считается безопасным).

## Структура

```
index.html            разметка и экраны
css/styles.css        тёмная mobile-first тема
css/neon.css          тема «Неон»
fonts/                шрифты темы «Неон»: Onest, Unbounded (SIL OFL 1.1)
js/ripple.js          «капля» при нажатии на кнопки
js/app.js             интерфейс, план, фоновая подготовка кусков
js/dictation.js       движок диктовки: прерывание, вопросы, возврат к куску
js/speech.js          SpeechSynthesis, SpeechRecognition, команды, защита от эха, Wake Lock
js/neural.js          голос на телефоне: загрузка, синтез в фоне, стиль
js/neural-worker.js   фоновый поток: модели ONNX (Silero, Piper)
js/silero-core.js     Silero в браузере: текст, ударения, омографы, интонация, звук
js/abbr.js            сокращения при диктовке («физ. лиц», «НДФЛ»)
voices/silero-ru/     файлы модели Silero (CC BY-NC-SA 4.0)
js/analyze.js         темы, план, оценка времени, генерация кусков и проверка полноты
js/ai.js              выбор провайдера нейросети
js/gemini.js          клиент Gemini API
js/anthropic.js       клиент Anthropic Messages API (Claude)
js/openai.js          клиент OpenAI-совместимых API (OpenRouter, DeepSeek, Mistral, свой адрес)
js/extract.js         txt/md/pdf/docx/фото
js/storage.js         localStorage (настройки, позиция) и IndexedDB (проект)
sw.js, manifest.webmanifest, icons/
docs/                 подробная документация, картинка для превью ссылки
LICENSE               GNU GPL v3 — для кода (у voices/ и fonts/ свои лицензии)
LICENSE.ru.md         кратко о лицензии по-русски
CHANGELOG.md          что изменилось в каждой версии
```

**Выпуск новой версии.** Поднимите одно и то же число в `VERSION` в `sw.js` и в `?v=` в `index.html` (importmap и `js/app.js`). Тогда все файлы новой версии загружаются вместе и не смешиваются со старыми из кэша браузера. Если запуск всё же сорвался, страница один раз сама перезагрузится со свежими файлами, а затем покажет, что данные на месте.
