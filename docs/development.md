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
css/light.css         светлая тема «Тетрадь»
css/aurora.css        «Аврора» — тёмное оформление по умолчанию (тёмная тема телефона)
css/ink.css           «Чернила» — светлое оформление по умолчанию (светлая тема телефона)
css/ios.css           оформление iOS
css/android.css       оформление Android в духе Material You
fonts/                шрифты тем: Nunito, Onest, Unbounded, Literata (SIL OFL 1.1)
js/ripple.js          «капля» при нажатии на кнопки
js/app.js             интерфейс, план, фоновая подготовка кусков
js/dictation.js       движок диктовки: прерывание, вопросы, возврат к куску
js/speech.js          SpeechSynthesis, SpeechRecognition, команды, защита от эха, Wake Lock
js/neural.js          голос на телефоне: загрузка, синтез в фоне, стиль
js/neural-worker.js   фоновый поток: модели ONNX (Silero, Piper)
js/silero-core.js     Silero в браузере: текст, ударения, омографы, интонация, звук
js/abbr.js            сокращения при диктовке («физ. лиц», «НДФЛ»)
js/commands.js        голосовые и текстовые команды приложения («перейди к третьей теме», «покажи формулы»)
js/lecture.js         запись лекции: расшифровка речи и наведение порядка нейросетью
js/i18n.js            язык интерфейса: перевод экрана по словарю на лету
js/i18n-en.js         английский словарь интерфейса
js/platform.js        iPhone или Android
js/config.js          адрес сервера бесплатного режима (без своего ключа)
js/stats.js           статистика занятий: минуты по дням, серия дней, экзамены
js/cheatsheet.js      шпаргалка: главное, термины («Х — это …»), формулы; печать и HTML-файл
js/audiobook.js       аудиоконспект для iPhone: озвучка нейроголосом и MP3 (lamejs)
js/tickets.js         билеты к экзамену: разбор списка, ответы по конспекту, «тяни билет», оценки
server/               сервер бесплатного режима для Cloudflare Workers — как поставить, в server/README.md
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
tests/                автотесты (npm test), tests/lib.mjs — сервер, заглушки нейросети и речи
package.json          только для тестов: само приложение без сборки и зависимостей
CHANGELOG.md          что изменилось в каждой версии
```

**Выпуск новой версии.** Поднимите одно и то же число в `VERSION` в `sw.js` и в `?v=` в `index.html` (importmap и `js/app.js`). Тогда все файлы новой версии загружаются вместе и не смешиваются со старыми из кэша браузера. Если запуск всё же сорвался, страница один раз сама перезагрузится со свежими файлами, а затем покажет, что данные на месте.

## Тесты

Автотесты открывают приложение в настоящем Chromium: проходят план, диктовку, «СТОП» и вопросы, формулы, числа, голосовые команды, клавиши, оформление, обмен конспектом, карточки, напоминания, запись лекции, iPhone, конспекты на английском и английский интерфейс. Нейросеть и голос в тестах — заглушки (`tests/lib.mjs`), поэтому ключ и интернет не нужны.

```
npm ci
npx playwright install chromium
npm test             # все тесты
npm test formulas    # только файлы, в имени которых есть «formulas»
npm start            # приложение на http://127.0.0.1:8080/
```

На GitHub тесты запускаются сами на каждый push и pull request (`.github/workflows/tests.yml`); результат — на вкладке Actions и в значке в README. Новый тест — файл `tests/NN-что-то.test.mjs` с `export default async ({ open, prepare, ok }) => { … }`.

**Перевод интерфейса.** Интерфейс написан по-русски, английский накладывается словарём `js/i18n-en.js`: точные строки (`EXACT`), строки с числами и названиями (`PATTERNS`) и единицы времени (`WORDS`). Добавили на экран новую надпись — добавьте её перевод в `EXACT`; тест `13-ui-english` найдёт русский текст, оставшийся без перевода. Содержимое конспекта и ответы нейросети не переводятся: такие элементы помечены `data-no-i18n`.
