# Simple GitHub Tray

Минималистичное расширение GNOME Shell: показывает аккаунт GitHub и собственные репозитории в верхней панели, отсортированные по числу звёзд.

## Совместимость

На машине разработки обнаружен **GNOME Shell 51.1**. Расширение использует ES-модули Shell 45+ и интерфейс настроек GTK 4/libadwaita, но в `metadata.json` заявлен только GNOME Shell 51: запуск внутри этой установленной сессии проверить не удалось.

## Возможности

- Иконка GitHub в правой части верхней панели, нативное выпадающее меню и подменю репозиториев.
- Аватар и логин аутентифицированного аккаунта, кнопки Refresh и Open GitHub Profile.
- Проверка токена через `GET /user`; расширение сообщает о несовпадении логина и не подменяет введённое имя.
- Показываются только репозитории, которыми владеет этот аккаунт. Репозитории, где аккаунт только участник, отфильтровываются.
- Репозитории сортируются по текущему `stargazers_count`, повторяющиеся записи убираются.
- В меню остаются последние данные во время обновления. Открытие меню использует кеш до пяти минут; ручной Refresh всегда запрашивает свежие данные. Таймер запускается один раз и не создаётся заново при открытии меню.
- Personal Access Token сохраняется как обычное значение GSettings по запросу пользователя. Токен не шифруется; поле настроек скрывает его символы, а запросы отправляют его только GitHub по HTTPS.

## Файлы

- `metadata.json` — UUID и версия Shell.
- `extension.js` — кнопка панели, меню, кеш и жизненный цикл.
- `prefs.js` — настройки GNOME Extensions на GTK 4/libadwaita.
- `githubApi.js` — асинхронные запросы GitHub REST API, обработка пагинации, ошибок и аватара.
- `schemas/org.gnome.shell.extensions.simple-github-tray.gschema.xml` — имя пользователя, токен и лимит списка.
- `github-mark-light.svg`, `github-mark-dark.svg` и `stylesheet.css` — варианты монохромного знака для светлой/тёмной панели и небольшие стили Shell. Значок выбирается по цвету текста панели и обновляется при смене темы.

## Зависимости

- GNOME Shell 51 и GNOME Extensions.
- GJS, GObject Introspection, GTK 4/libadwaita и libsoup 3 (обычно устанавливаются вместе с GNOME).
Установка самого расширения не требует root. Secret Service и GNOME Keyring не требуются.

## Установка текущему пользователю

Выполните из каталога проекта:

```sh
uuid='simple-github-tray@whoamii9669-ai.github.io'
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"
install -d "$dest"
cp metadata.json extension.js prefs.js githubApi.js stylesheet.css github-mark-light.svg github-mark-dark.svg "$dest/"
cp -r schemas "$dest/"
glib-compile-schemas "$dest/schemas"
```

Чтобы собрать переносимый `.shell-extension.zip` с дополнительными модулями и ресурсами:

```sh
gnome-extensions pack --force --out-dir outputs \
  --extra-source=githubApi.js \
  --extra-source=github-mark-light.svg \
  --extra-source=github-mark-dark.svg \
  --extra-source=README.md \
  --extra-source=LICENSE .
```

Установить собранный пакет:

```sh
gnome-extensions install outputs/simple-github-tray@whoamii9669-ai.github.io.shell-extension.zip
```

После ручного копирования или установки ZIP GNOME Shell может не обнаружить новое расширение в уже запущенном сеансе. Выйдите из сеанса GNOME и войдите снова. На Wayland сочетание Alt+F2 → `r` не перезапускает Shell. Затем выполните команды отдельно:

```sh
gnome-extensions enable simple-github-tray@whoamii9669-ai.github.io
gnome-extensions prefs simple-github-tray@whoamii9669-ai.github.io
```

Отключить расширение:

```sh
gnome-extensions disable simple-github-tray@whoamii9669-ai.github.io
```

## Первоначальная настройка

1. В настройках расширения укажите `GitHub Username`.
2. Создайте fine-grained Personal Access Token. Для публичных репозиториев дополнительные права репозитория не нужны; при отсутствии разрешения на список доступных репозиториев расширение отдельно загружает публичные собственные репозитории без токена. Для приватных репозиториев включите **Metadata: read** только для выбранных репозиториев. Для `GET /user` fine-grained token не требует дополнительных разрешений.
3. Введите токен в скрытое поле. Кнопка с глазом показывает или скрывает введённое значение. Нажмите **Save**: имя пользователя и токен сохраняются в GSettings, поле токена остаётся скрытым. Проверка подключения также сохраняет введённый токен.
4. Нажмите **Check connection**. Успешная проверка подтвердит, что GitHub-аутентификация соответствует введённому имени.
5. Выберите 5, 10, 20, 50 репозиториев или все доступные.

Токен хранится в обычных настройках GNOME без шифрования. Он доступен локальным процессам, работающим от имени пользователя. Удалить его можно кнопкой **Remove token**.

Если токен сохранялся предыдущей версией расширения в Secret Service, введите его повторно и нажмите **Save**: новая версия читает токен из GSettings. Старая запись в Secret Service автоматически не удаляется.

Можно пользоваться classic PAT, но для приватных репозиториев он обычно требует более широкого `repo` scope. Fine-grained token с read-only Metadata предпочтительнее.

## Пагинация и лимит отображения

GitHub REST API для списка репозиториев не умеет сортировать `/user/repos` по `stargazers_count`. Поэтому расширение проходит все страницы собственных репозиториев (по 100 записей), затем сортирует их локально и показывает выбранное количество. Это необходимо, чтобы выбранные первые 5/10/20/50 записей действительно были самыми звёздными, а не случайным подмножеством.

Приватные репозитории доступны только если токен имеет права на них. Для вывода только публичных репозиториев достаточно ограничить токен публичными данными, если конкретный тип токена это позволяет.

## Проверки и диагностика

Проверить синтаксис JavaScript из каталога проекта:

```sh
for file in extension.js prefs.js githubApi.js; do
  gjs -c "Reflect.parse(new TextDecoder().decode(imports.gi.GLib.file_get_contents(ARGV[0])[1]), {target: 'module'});" "$file"
done
```

Проверить XML-схему и её диапазоны:

```sh
glib-compile-schemas --strict --dry-run schemas/
```

Скомпилировать схему для установки:

```sh
glib-compile-schemas schemas/
```

Посмотреть состояние и сообщения Shell:

```sh
gnome-extensions info simple-github-tray@whoamii9669-ai.github.io
journalctl --user -f _COMM=gnome-shell
```

Сообщения процесса настроек обычно видны здесь:

```sh
journalctl --user -f _COMM=gjs
```

Типовые причины ошибок:

- **HTTP 401** — токен неверен, отозван или истёк.
- **Логин не совпадает** — в настройках сохранено имя, отличающееся от аккаунта токена. Исправьте одно из полей самостоятельно.
- **HTTP 403/429** — возможен лимит GitHub API; если лимита нет, проверьте Metadata: read и доступ токена к приватным репозиториям.
- **Нет соединения/тайм-аут** — проверьте интернет-соединение и повторите запрос кнопкой Refresh.
- **Пустой список** — у аккаунта может не быть собственных репозиториев или токен может не иметь доступа к приватным.

## Ограничения проверки

В текущей среде доступны GNOME Shell 51.1, GJS, GTK 4, libadwaita и libsoup 3. Проверены статический синтаксис и GSettings-схема. Интерактивную сессию GNOME Shell и сетевой вход с GitHub проверить не удалось.

## Лицензия и товарные знаки

Код проекта распространяется по MIT License (см. `LICENSE`). Знак GitHub является товарным знаком GitHub, Inc. и используется только для обозначения интеграции с GitHub; проект не связан с GitHub и не одобрен компанией. Смотрите [официальные рекомендации GitHub по логотипу](https://brand.github.com/foundations/logo) и [политику GitHub](https://docs.github.com/en/site-policy/other-site-policies/github-logo-policy).
