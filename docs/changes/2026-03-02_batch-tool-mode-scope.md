# Batch tool: mode-scoped schema and documentation

## Batch tool

- **Доступ во всех режимах**: инструмент `batch` доступен в agent, plan и ask.
- **Изменение файлов только в agent**: в режиме **agent** в batch передаются поля `reads`, `searches`, `replaces`. В режимах **plan** и **ask** в схему batch входят только `reads` и `searches` — полей для правок кода нет, модель не может отправить `replaces`.
- **Инструкции**: расширены описания (when to use, parameters, порядок выполнения, лимиты 25 reads / 15 searches / 20 replaces в agent).

Реализация: `getBatchToolForMode(mode)` в core возвращает полный batch-tool для agent и read-only вариант для plan/ask; registry в `getForMode(mode)` подставляет нужный вариант по имени `batch`.

## Документация

- **DOCS.md**: в таблицу встроенных инструментов добавлена строка для **batch** с указанием режимов и того, что в plan/ask доступны только чтение и поиск.
