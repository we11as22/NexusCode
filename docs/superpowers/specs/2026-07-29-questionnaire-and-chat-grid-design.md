# Единая сетка чата и AskQuestion — дизайн

**Дата:** 2026-07-29

**Статус:** утверждён активной целью и командой продолжать

**Область:** VS Code webview, CLI, core-контракт вопроса, durable transcript

## Цель

Исправить не отдельные пиксели, а общий контракт представления одного хода
NexusCode. Расширение должно иметь ровную Cursor-подобную композицию, в которой
пользовательское сообщение, `Worked`, техническая лента, финальный ответ и
composer используют предсказуемую горизонтальную сетку. `AskQuestion` должен
быть полноценным интерактивным состоянием агента в расширении и CLI, не
создавать пустых вариантов, не дублировать оболочки и не провоцировать циклы
уточнений.

## Подтверждённые причины дефектов

### 1. Пустой вариант вопроса

`QuestionnaireBar` в VS Code всегда дописывает synthetic custom option, даже
если запрос не разрешает произвольный ответ. Для этой строки компонент
отрисовывает пустой placeholder вместо label. Поэтому на скриншоте появляется
третий пункт без текста.

Core сейчас устанавливает `allowCustom: true` для каждого вопроса, но
представления не используют это поле как контракт. CLI показывает custom
option явно, а webview — нет. Две поверхности интерпретируют один запрос
по-разному.

### 2. Лишние оболочки

При активном вопросе webview сохраняет обычную рамку composer, добавляет
`nexus-questionnaire-input-area`, а внутри создаёт ещё одну карточку с border и
radius. В результате вопрос выглядит как форма внутри другой формы, а нижняя
строка режима относится визуально неясно к какой из них.

### 3. Накопление горизонтальных отступов

Существующие уровни независимо добавляют inset:

- `message-list` задаёт внешний gutter;
- `AssistantText` и tool card добавляют `--nexus-content-inset`;
- раскрытый `Worked` добавляет ещё один left padding;
- вложенные technical cards повторно центрируют себя через тот же inset.

Итоговый сдвиг является суммой трёх уровней, поэтому tool/diff card начинается
существенно правее user message, `Worked` и финального ответа.

### 4. Неполный lifecycle AskQuestion

Webview всегда показывает pager `1 of 1`, не имеет отдельного review шага для
нескольких вопросов и пересоздаёт список options на каждом render. Глобальный
keydown listener из-за этого переустанавливается без необходимости. CLI уже
имеет review/navigation, но не разделяет interactive и non-interactive
capabilities.

### 5. Слишком мягкий контракт core

Нормализация дополняет плохой запрос модели искусственными вариантами
`Brief answer`/`Detailed answer`. Это скрывает ошибку генерации схемы и может
создавать бессмысленный UX. Описание инструмента правильно запрещает
использовать вопрос вместо approval, но недостаточно жёстко требует один
батч всех уже известных уточнений и прекращение tool loop после запроса.

## Проверенные образцы

### Cursor

Предоставленные скриншоты задают визуальный результат для VS Code:

- одна основная колонка;
- `Worked for …` скрывает всю техническую работу хода;
- раскрытая техническая лента имеет только один визуальный уровень;
- diff и terminal cards выровнены между собой;
- финальный ответ остаётся снаружи `Worked`;
- composer является одной цельной поверхностью.

Cursor используется как визуальный и поведенческий ориентир, но его
закрытая реализация не считается источником архитектурного контракта.

### OpenClaude

OpenClaude задаёт лучший проверенный lifecycle вопроса:

- 1–4 вопроса;
- 2–4 уникальных содержательных варианта;
- явный `Other` с собственным вводом;
- последовательная навигация;
- review/submit для нескольких вопросов;
- tool блокирует продолжение агента до ответа;
- вопрос не подменяет permission request.

Его terminal UI является главным ориентиром для CLI Nexus.

### Kimi CLI

Kimi различает наличие client capability: AskUserQuestion не предлагается
модели, если текущая поверхность не умеет принять ответ. Неинтерактивный режим
не должен навсегда зависать на вопросе.

### Codex

Codex полезен разделением protocol event, durable item и UI projection. Pending
question является состоянием хода с устойчивым идентификатором, а не
произвольной строкой tool output.

### Kilo

Kilo полезен единым server/client event ordering и централизованной mode/tool
visibility. Однако перенос всего транспорта не решит локальные ошибки
проекции и создаст ненужный риск. Nexus сохраняет существующий transport и
усиливает его контракт.

## Выбранная архитектура

### 1. Один горизонтальный grid

У transcript появляется три семантические линии:

1. **root** — внешний gutter колонки;
2. **content** — root плюс один компактный inset для assistant/technical
   содержания;
3. **edge-to-edge** — элементы, которым нужна вся ширина composer.

Конкретные правила:

- user bubble и `Worked` начинаются на `root`;
- финальный assistant answer начинается на `content`;
- children раскрытого `Worked` начинаются на `content`;
- child card внутри `Worked` больше не применяет собственное центрирование;
- thought, exploration, bash, diff, approval, subagent и error cards имеют
  одинаковую ширину и левую границу;
- sticky changes bar и composer используют `root`;
- внутри карточки разрешён только внутренний padding, не новый внешний inset.

Grid задаётся родителем через CSS custom properties. Дочерний компонент не
вычисляет ширину как `100% - 2 * inset`, если он уже находится в content slot.
Это устраняет накопление отступов конструктивно.

### 2. Worked является единственным контейнером технической истории

После `done` один `CompletedWorkBlock` содержит всю техническую работу между
user message и каноническим финальным ответом:

- reasoning;
- read/list/search exploration;
- terminal/bash;
- tool calls;
- approvals и вопросы;
- plan/todo;
- subagent lifecycle;
- compaction/retry/status.

Финальный ответ остаётся соседним элементом после блока. При раскрытии
`Worked` его children получают локальный вертикальный gap, но не глобальные
message margins. Пустые reasoning/status элементы удаляются проектором.

### 3. AskQuestion как состояние composer

Pending question заменяет текстовую область внутри существующего единого
composer shell:

- нет второй внешней рамки;
- mode/model row остаётся общей нижней строкой;
- вопрос имеет title, список вариантов и компактный footer;
- pager скрыт при одном вопросе;
- `Other` имеет явный label и поле `Type your own answer`;
- custom option создаётся только при `allowCustom`;
- `Dismiss` явно отменяет вопрос и продолжает согласованный cancel-flow;
- `Continue` активируется только при валидном ответе;
- `Esc` выполняет dismiss, `Enter` подтверждает заполненный шаг,
  `Cmd/Ctrl+Enter` отправляет review;
- keyboard shortcuts не перехватываются вне активного questionnaire.

В VS Code одиночный single-select не отправляется одним кликом: пользователь
выбирает ответ и подтверждает `Continue`. Это защищает от случайной отправки
мышью. В CLI выбор может сразу переходить на следующий вопрос; последний шаг
всё равно подтверждается review, если вопросов несколько.

### 4. Полный multi-question lifecycle

Для одного вопроса UI показывает только сам вопрос и submit footer. Для двух и
более:

1. пользователь отвечает последовательно;
2. Back/Next доступны в пределах массива;
3. последний Next открывает Review;
4. Review показывает все вопросы и нормализованные ответы;
5. Edit возвращает к нужному вопросу;
6. Submit отправляет один структурированный response;
7. durable transcript показывает компактное `вопрос → ответ` без служебных
   placeholder-ов.

Answers хранятся по стабильному `question.id`, а options мемоизируются. Listener
подписывается один раз на время pending state и очищается при resolve, dismiss,
session switch и disposal.

### 5. Строгая нормализация core

Core принимает 1–4 вопроса. Каждый вопрос:

- имеет непустой уникальный id и header;
- имеет 2–4 уникальных непустых model-provided options;
- не содержит вручную созданный `Other`;
- явно задаёт `allowCustom`;
- сохраняет `multiSelect`.

Невалидный tool call возвращает модели bounded validation error с конкретной
причиной. Core не придумывает смысловые варианты за модель. Совместимость со
старыми persisted pending requests обеспечивается отдельной tolerant
read-normalization, но новые calls проверяются строго.

Tool description требует:

- спрашивать только действительно блокирующую информацию;
- сначала исследовать workspace и настройки доступными read-only tools;
- объединять все известные уточнения в один вызов;
- не спрашивать подтверждение безопасного действия, уже разрешённого режимом;
- не использовать вопрос вместо permission/approval;
- после вызова остановить tool loop до ответа;
- предлагать конкретные, взаимоисключающие варианты;
- первым ставить рекомендуемый вариант с кратким последствием;
- не добавлять `Other`, поскольку его предоставляет host.

### 6. Capability и non-interactive behavior

Mode/tool manifest включает AskQuestion только когда host сообщает
`supportsInteractiveQuestions: true`.

- VS Code webview и интерактивный CLI поддерживают вопрос.
- CLI print/headless не зависает: инструмент недоступен модели. Если старый
  queued call всё же восстановлен, он завершается понятной ошибкой
  `interactive input unavailable`.
- remote transport обязан явно объявить capability; неизвестное значение
  трактуется как unsupported.

Это повторяет проверенный принцип Kimi и предотвращает скрытое ожидание stdin.

### 7. Transport и durable state

Pending question имеет стабильные поля:

```ts
type PendingQuestionnaire = {
  requestId: string
  toolCallId: string
  questions: NormalizedQuestion[]
  activeQuestionId: string
  phase: "answering" | "review"
  answers: Record<string, NormalizedAnswer>
}
```

Core владеет семантикой запроса, host — только capability и способом ввода,
UI — временным draft. В durable transcript сохраняется только завершённый
tool part и итоговые ответы; незавершённый draft не записывает секретные или
частичные значения на диск. State snapshot и event stream используют один
`requestId`, поэтому replay не создаёт второй questionnaire.

### 8. Error handling

- validation error показывается как нормальный bounded tool error;
- session switch/dismiss разрешает ожидающий promise ровно один раз;
- duplicate submit игнорируется по `requestId`;
- поздний ответ на старый request отклоняется;
- submit во время running state не создаёт параллельный root turn;
- exception в webview не оставляет core promise навсегда pending;
- ответы не включаются в telemetry/logs сверх обычного durable transcript;
- длинные option/answer строки ограничиваются до безопасного размера.

### 9. Визуальные детали

- одна рамка composer/questionnaire;
- одинаковый radius и border с обычным composer;
- высота option row определяется содержимым, без пустых пронумерованных строк;
- label и description имеют устойчивую baseline;
- selection использует theme tokens VS Code, а не фиксированный синий;
- focus ring видим с клавиатуры;
- кнопки не прыгают при появлении validation message;
- narrow webview складывает footer без горизонтального overflow;
- zoom 80–200% и системный font scale не обрезают controls;
- screen reader получает `fieldset`, `legend`, `aria-current`,
  `aria-describedby` и live validation status.

## Декомпозиция реализации

Эта спецификация является первым вертикальным срезом большой цели:

1. strict core contract и capability;
2. общая question state machine;
3. VS Code questionnaire;
4. CLI questionnaire;
5. chat grid и Worked children;
6. durable/replay/error paths;
7. automated и ручная проверка.

После этого отдельными проверяемыми срезами проходят:

- plans/todo;
- approvals/permissions;
- queue/streaming;
- settings/modes/model picker;
- diff/review/undo/keep;
- subagent lifecycle;
- prompts/tool visibility/context/compaction/memory;
- полный CLI parity audit.

Это не сокращает активную цель: декомпозиция нужна, чтобы каждый слой имел
доказуемый контракт и не маскировался общим зелёным build.

## Проверка

### Автоматические тесты

1. strict normalization принимает 1–4 валидных вопроса и отклоняет пустые,
   повторяющиеся и synthetic options;
2. custom option появляется только при `allowCustom`;
3. single-question UI не показывает pager и пустые строки;
4. multi-question state machine проходит answer/back/review/edit/submit;
5. duplicate/late submit не запускает второй turn;
6. session switch и dismiss освобождают pending promise;
7. headless manifest не содержит AskQuestion;
8. projection snapshot подтверждает один content inset внутри `Worked`;
9. replay даёт один questionnaire и один итоговый answer summary;
10. listeners/timers/disposables возвращаются к исходному числу после циклов.

### Безопасные ручные сценарии

Только в `/Users/mac/Projects/nexus/test`, без индексации и нагрузочного
сканирования:

- один вопрос с single-select;
- один вопрос с `Other`;
- несколько вопросов, Back/Edit/Review;
- dismiss и повторный вопрос;
- resize narrow/wide, zoom и keyboard-only;
- reload webview во время и после вопроса;
- question рядом с reasoning, exploration/search, bash, diff и final answer;
- раскрытие/сворачивание `Worked`;
- CLI interactive question и headless отказ без зависания;
- повторная сессия без дублей.

### Гейты

- targeted unit/component tests;
- core, CLI и VS Code typecheck;
- runtime tests;
- production webview build;
- VSIX packaging;
- bounded resource/leak checks;
- реальные скриншоты до/после для wide и narrow webview;
- `git diff --check`;
- отсутствие изменений вне тестовой директории от runtime smoke.

## Критерии приёмки

1. На вопросе нет пустого третьего пункта, двойной рамки и `1 of 1`.
2. `Other` видим и работает одинаково в CLI и расширении.
3. Multi-question flow имеет review и не теряет ответы.
4. Невалидный model call не превращается в искусственные варианты.
5. Неинтерактивный CLI никогда не ждёт скрытый ответ.
6. User message, `Worked`, technical cards, final answer и composer следуют
   единой сетке; внутри `Worked` inset применяется ровно один раз.
7. Thought/search/bash/diff/plan/todo/subagent cards не получают отдельные
   горизонтальные дрейфы.
8. Данные вопроса не дублируются при replay/reload/late event.
9. После многократных mount/unmount и question cycles нет оставшихся
   listeners, timers, promises или растущих массивов.
10. Все автоматические и перечисленные ручные проверки подтверждены перед
    push.
