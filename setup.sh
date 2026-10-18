#!/bin/sh

GREEN=$'\033[32m'
GREEN_BOLD=$'\033[1;32m'
RED=$'\033[31m'
RED_BOLD=$'\033[1;31m'
NC=$'\033[0m'
NCN="$NC\n\n"
BLUE=$'\033[1;34m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[1;96m'

ERROR="\n${RED} ❌${RED_BOLD}"
SUCCESS="\n${GREEN} ✅${GREEN_BOLD}"
INFO="\n${CYAN} ℹ️ "

XKEENUI_BIN="/opt/sbin/xkeen-ui"
XKEENUI_INIT="/opt/etc/init.d/S99xkeen-ui"
STATIC_DIR="/opt/share/www/XKeen-UI"
LIGHTTPD_INIT="/opt/etc/init.d/S80lighttpd"
LIGHTTPD_DIR="/opt/etc/lighttpd"
LIGHTTPD_CONF="$LIGHTTPD_DIR/conf.d/90-xkeenui.conf"

XKEEN_BIN="/opt/sbin/xkeen"
XRAY_BIN="/opt/sbin/xray"
# Init-скрипт XKeen: S05xkeen в текущих версиях, S99xkeen в старых
XKEEN_INITS="/opt/etc/init.d/S05xkeen /opt/etc/init.d/S99xkeen"
XKEEN_CONFIG="/opt/etc/xkeen/xkeen.json"
NDMC="/bin/ndmc"
# Метка токенов доступа, которые выпускает этот скрипт: по ней находятся и снимаются только свои
TOKEN_LABEL="XKeenPQ-UI"
XKEEN_INSTALLER="https://raw.githubusercontent.com/jameszeroX/XKeen/main/install.sh"
# Пункты установки XKeen для режима auto: ядро Xray, геобазы, GeoIPSET, их автообновление и автозагрузка
XKEEN_AUTO_ARGS="-i auto cores=xray"

BETA=false
LOCAL=false
AUTO=false
TOKEN=""
for arg in "$@"; do
  case "$arg" in
    beta) BETA=true ;;
    auto) AUTO=true ;;
    token=*) TOKEN="${arg#token=}" ;;
  esac
done

spinner() {
  local pid=$1 msg=$2
  trap 'kill "$pid" 2>/dev/null; printf "\r${RED} ❌ ${NC}%s\033[K\n" "$msg"; printf "\033[?25h"; return 130' INT
  set -- ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
  printf "\033[?25l"
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r${GREEN} %s ${NC} %s\033[K" "$1" "$msg"
    set -- "$@" "$1"
    shift
    usleep 100000
  done
  printf "\033[?25h"
  wait "$pid" && printf "\r ✔  %s\033[K\n" "$msg" || { printf "\r ❌ %s\033[K\n" "$msg"; return 1; }
}

get_arch() {
  case "$(opkg print-architecture)" in
    *aarch64*) ARCH='arm64-v8a' ;;
    *mipsel*)  ARCH='mips32le' ;;
    *mips*)    ARCH='mips32' ;;
    *) printf "${RED_BOLD}\n Не удалось определить архитектуру.${NCN}" >&2; exit 1 ;;
  esac
}

download_files() {
  local base_url="https://github.com/postq-vpn/XKeenPQ-UI/releases"
  local download_url="$base_url/latest/download"
  local bin_name="xkeen-ui-$ARCH"

  if [ "$BETA" = true ]; then
    local beta_tag="/tmp/xkeen_beta"
    trap "rm -f $beta_tag" EXIT
    (curl -s https://api.github.com/repos/postq-vpn/XKeenPQ-UI/releases | \
  jq -re '.[0] | select(.prerelease == true) | .tag_name' > $beta_tag) &
    if ! spinner $! "Поиск бета-релиза..."; then
      printf "${RED_BOLD}\n Нет актуального бета-релиза${NCN}"
      $XKEENUI_INIT start &>/dev/null || :
      exit 1
    fi
    beta_tag=$(cat $beta_tag)
    download_url="$base_url/download/$beta_tag"
  fi

  if [ "$LOCAL" = true ] && [ -f "/opt/tmp/$bin_name" ]; then
    ( set -e; mv "/opt/tmp/$bin_name" $XKEENUI_BIN && chmod +x $XKEENUI_BIN ) &
    if ! spinner $! "Локальная установка бинарника..."; then
      printf "${RED_BOLD}\n Не удалось переместить бинарник.${NCN}"
      exit 1
    fi
  else
    ( set -e; curl -Lsfo $XKEENUI_BIN $download_url/$bin_name && chmod +x $XKEENUI_BIN ) &
    if ! spinner $! "Загрузка бинарника..."; then
      printf "${RED_BOLD}\n Не удалось загрузить бинарник.${NCN}"
      exit 1
    fi
  fi
}

install_xkeenui() {
  if [[ -d $STATIC_DIR || -f $XKEENUI_BIN || -f $XKEENUI_INIT || -f $LIGHTTPD_CONF ]]; then
    printf "${YELLOW}\n Обнаружены файлы XKeen UI, запуск переустановки...\n${NC}"
    uninstall_xkeenui
  fi

  printf "${INFO} Начинаем установку...${NCN}"

  [ -f "/opt/tmp/xkeen-ui-$ARCH" ] && LOCAL=true

  download_files; create_xkeenui_init

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start &>/dev/null &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  finish_setup "установлен"
}

update_xkeenui() {
  [ -f "$XKEENUI_BIN" ] || { printf "${ERROR} Ошибка: XKeen UI не установлен!${NCN}"; exit 1; }

  printf "${INFO} Начинаем обновление...${NCN}"

  if [ ! -f $XKEENUI_INIT ]; then
    (
      set -e
      killall -q -9 xkeen-ui &>/dev/null || :
      create_xkeenui_init
    ) &
    spinner $! "Создание скрипта запуска..."
  elif pidof xkeen-ui &>/dev/null; then
    (
      sed -i 's|^PROCS=/opt/sbin/xkeen-ui$|PROCS=xkeen-ui|' /opt/etc/init.d/S99xkeen-ui
      $XKEENUI_INIT stop &>/dev/null || :
      killall -q -9 xkeen-ui || :
    ) &
    spinner $! "Остановка XKeen UI..."
  else
    sed -i 's|^PROCS=/opt/sbin/xkeen-ui$|PROCS=xkeen-ui|' /opt/etc/init.d/S99xkeen-ui
  fi

  legacy_installation_check; download_files

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start &>/dev/null &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  finish_setup "обновлен"
}

uninstall_xkeenui() {
  if [ "$AUTO" != true ]; then
    printf "\n Данное действие ${RED_BOLD}удалит${NC} XKeen UI, его файлы и зависимости.\n\n"
    read -p " Продолжить? [y/N]: " response < /dev/tty
    response=$(printf '%s' "$response" | tr -cd 'YyNn')
    case "$response" in
      [Yy]) printf "${INFO} Начинаем удаление...${NCN}";;
      *) printf "${ERROR} Отмена операции.${NCN}"; exit 1;;
    esac
  fi

  (
    if [[ -f "$LIGHTTPD_INIT" && -f "$LIGHTTPD_CONF" ]]; then
      if $LIGHTTPD_INIT status &>/dev/null; then
          $LIGHTTPD_INIT stop &>/dev/null || :
          opkg remove --autoremove --force-removal-of-dependent-packages lighttpd &>/dev/null
          rm -rf $LIGHTTPD_DIR
      fi
    fi
    if [ -f $XKEENUI_INIT ]; then
      if $XKEENUI_INIT status &>/dev/null; then
        $XKEENUI_INIT stop &>/dev/null || :
        killall -q -9 xkeen-ui || :
      fi
    fi
  ) &
  spinner $! "Остановка XKeen UI..."

  (rm -rf $STATIC_DIR; rm -f $XKEENUI_BIN $XKEENUI_INIT) &
  spinner $! "Удаление файлов XKeen UI..."
  printf "${SUCCESS} Удаление XKeen-UI завершено${NCN}"
}

finish_setup() {
  local ip=$(ip -4 a s br0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p'); ip=${ip:-"IP_Роутера"}
  local port=$(sed -n 's/.*-p \([0-9]*\).*/\1/p' $XKEENUI_INIT 2>/dev/null); port=${port:-1000}

  printf "${SUCCESS} XKeen UI успешно $1!${NCN}"
  printf " Панель доступна по адресу: ${GREEN_BOLD}http://$ip:$port${NC}\n\n"
}

legacy_installation_check() {
  if [ -f "$LIGHTTPD_CONF" ]; then
    $LIGHTTPD_INIT status &>/dev/null && $LIGHTTPD_INIT stop
    rm -f "$LIGHTTPD_CONF"
    printf "${YELLOW}\n Веб-сервер lighttpd для работы XKeen UI более не используется.\n${NC}"
    response=y
    [ "$AUTO" = true ] || read -p " Удалить его? [Y/n]: " response < /dev/tty
    response=$(printf '%s' "$response" | tr -cd 'YyNn')
    case "$response" in
      [Nn]) return;;
      *) opkg remove --autoremove --force-removal-of-dependent-packages lighttpd; rm -rf $LIGHTTPD_DIR;;
    esac
  fi
}

create_xkeenui_init() {
  cat << EOF > $XKEENUI_INIT
#!/bin/sh

ENABLED=yes
PROCS=xkeen-ui
ARGS="-p 1000"
PREARGS=""
DESC="\$PROCS"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
EOF
  chmod +x $XKEENUI_INIT
}

# Ставит XKeen без вопросов его же установщиком: тот в конце запускает интерактивный `xkeen -i`,
# поэтому последняя строка заменяется на `xkeen $XKEEN_AUTO_ARGS`.
install_xkeen_auto() {
  local installer="/opt/tmp/xkeen-install.sh"
  mkdir -p /opt/tmp
  ( curl -Lsf "$XKEEN_INSTALLER" -o "$installer" || curl -Lsf "https://gh-proxy.com/$XKEEN_INSTALLER" -o "$installer" ) &
  if ! spinner $! "Загрузка установщика XKeen..."; then
    printf "${RED_BOLD}\n Не удалось загрузить установщик XKeen.${NCN}"
    exit 1
  fi
  sed -i "s|^exec /opt/sbin/xkeen -i\$|exec /opt/sbin/xkeen $XKEEN_AUTO_ARGS|" "$installer"
  if ! grep -q "^exec /opt/sbin/xkeen $XKEEN_AUTO_ARGS\$" "$installer"; then
    rm -f "$installer"
    printf "${RED_BOLD}\n Установщик XKeen изменился, автоустановка невозможна.${NC}\n"
    printf " Установите XKeen по инструкции https://github.com/jameszeroX/XKeen и запустите эту команду снова.\n\n"
    exit 1
  fi
  printf "${INFO} Установка XKeen...${NCN}"
  # stdin не из конвейера curl | sh: иначе установщик прочитает остаток этого скрипта
  ( cd /opt/tmp && sh "$installer" --stable ) < /dev/null
  rm -f "$installer"
}

# Панель работает только с Xray. `xkeen -xray` останавливает Mihomo и переключает init-скрипт XKeen;
# если прокси работал, XKeen запускается уже на Xray.
switch_to_xray() {
  local was_running=false
  pidof mihomo &>/dev/null && was_running=true
  if grep -qs 'name_client="mihomo"' $XKEEN_INITS; then
    "$XKEEN_BIN" -xray < /dev/null &>/dev/null &
    spinner $! "Переключение XKeen на ядро Xray..."
    if grep -qs 'name_client="mihomo"' $XKEEN_INITS; then
      printf "${ERROR} Не удалось переключить XKeen на ядро Xray.${NCN}"
      exit 1
    fi
  elif [ "$was_running" = true ]; then
    # init-скрипт уже на Xray (прежние версии панели меняли только его), а Mihomo ещё работает
    killall -q mihomo &>/dev/null || :
  else
    return 0
  fi
  [ "$was_running" = true ] && { "$XKEEN_BIN" -start < /dev/null &>/dev/null || :; }
}

# Код ответа RCI роутера; $1 — токен доступа (пусто — без токена)
rci_code() {
  if [ -n "$1" ]; then
    curl --noproxy '*' -m 5 -s -o /dev/null -w "%{http_code}" -H "X-Ndma-Tkn: $1" http://127.0.0.1:79/rci/show/version
  else
    curl --noproxy '*' -m 5 -s -o /dev/null -w "%{http_code}" http://127.0.0.1:79/rci/show/version
  fi
}

# Вывод консоли роутера без управляющих последовательностей (ndmc печатает ^[[K)
ndmc_run() {
  "$NDMC" -c "$1" 2>&1 | sed "s/$(printf '\033')\[[0-9;]*[A-Za-z]//g"
}

# Выпускает токен доступа через консоль роутера (KeeneticOS 5.2+): локально, без пароля.
# Прежние токены с меткой $TOKEN_LABEL снимаются после выпуска нового, чужие не трогаются.
generate_rci_token() {
  [ -x "$NDMC" ] || return 1
  local out parsed new_id tok id
  out=$(ndmc_run "authentication token generate $TOKEN_LABEL")
  # До 5.2 такой команды нет
  case "$out" in *"no such command"*|*"not found"*|*"unknown command"*|*Command::*rror*) return 1 ;; esac
  # Токен — в строке «value:»; длинное значение ndmc переносит на следующие строки без «:»
  parsed=$(printf '%s\n' "$out" | awk '
    { sub(/^[ \t]+/, ""); sub(/[ \t]+$/, "") }
    in_val && ($0 == "" || /:/) { in_val = 0; got = 1 }
    in_val { val = val $0; next }
    got { next }
    /^id:/ { id = $2 }
    /^value:/ { in_val = 1; v = $0; sub(/^value:[ \t]*/, "", v); val = v }
    END { print id " " val }')
  new_id=${parsed%% *}
  tok=${parsed#* }
  case "$tok" in *[!A-Za-z0-9]*) tok="" ;; esac
  [ "${#tok}" -ge 32 ] || tok=""
  if [ -z "$tok" ]; then
    # Выпущен, но не разобран — снимаем, чтобы не оставлять на роутере бессрочный токен admin
    revoke_own_tokens ""
    return 1
  fi
  revoke_own_tokens "$new_id"
  ndmc_run "system configuration save" >/dev/null
  TOKEN="$tok"
}

# Снимает токены с меткой $TOKEN_LABEL, кроме токена с id $1
revoke_own_tokens() {
  local id
  for id in $(ndmc_run "show authentication token" | awk -v want="$TOKEN_LABEL" -v keep="$1" '
    { sub(/^[ \t]+/, "") }
    /^id:/ { id = $2 }
    /^user-data:/ { v = $0; sub(/^user-data:[ \t]*/, "", v); if (v == want && id != keep) print id }'); do
    ndmc_run "authentication token delete $id" >/dev/null
  done
}

# Записывает $TOKEN в xkeen.json: заменяет значение rci_token или создаёт файл
write_rci_token() {
  mkdir -p "${XKEEN_CONFIG%/*}"
  if grep -qs '"rci_token"' "$XKEEN_CONFIG"; then
    sed -i "s|\"rci_token\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"rci_token\": \"$TOKEN\"|" "$XKEEN_CONFIG"
  elif grep -qs '"xkeen"' "$XKEEN_CONFIG"; then
    printf "${ERROR} Добавьте токен в ${XKEEN_CONFIG} вручную: \"rci_token\": \"<токен>\" в разделе \"xkeen\".${NCN}"
    exit 1
  else
    printf '{\n  "xkeen": {\n    "rci_token": "%s"\n  }\n}\n' "$TOKEN" > "$XKEEN_CONFIG"
  fi
}

saved_rci_token() {
  sed -n 's/.*"rci_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$XKEEN_CONFIG" 2>/dev/null | head -n 1
}

# KeeneticOS 5.2 и новее пускают XKeen к RCI только с токеном из xkeen.json. Токен из token=…
# записывается туда; без него скрипт выпускает токен сам. Без рабочего токена установка не начинается.
prepare_rci_token() {
  local manual=false
  if [ -n "$TOKEN" ]; then
    manual=true
    case "$TOKEN" in
      *[!A-Za-z0-9._~-]*) printf "${ERROR} Токен содержит недопустимые символы.${NCN}"; exit 1 ;;
    esac
    write_rci_token
  fi
  case "$(rci_code "$(saved_rci_token)")" in
    401|403) ;;
    *) return 0 ;;
  esac
  if [ "$manual" = true ]; then
    printf "${ERROR} Роутер не принял токен доступа. Создайте новый и запустите команду снова.${NCN}"
    exit 1
  fi
  if generate_rci_token; then
    write_rci_token
    case "$(rci_code "$TOKEN")" in
      401|403) ;;
      *) printf " Токен доступа к роутеру получен\n"; return 0 ;;
    esac
  fi
  printf "${ERROR} Не удалось получить токен доступа к роутеру автоматически.${NC}\n"
  printf " Создайте его в веб-интерфейсе роутера в разделе «Пользователи и доступ» и добавьте в команду:\n"
  printf " ${GREEN_BOLD}… | sh -s -- auto token=ВАШ_ТОКЕН${NCN}"
  exit 1
}

auto_setup() {
  printf "${INFO} Автоматическая установка XKeen и XKeen UI${NCN}"
  prepare_rci_token
  if [ ! -x "$XKEEN_BIN" ]; then
    install_xkeen_auto
  elif [ ! -x "$XRAY_BIN" ]; then
    # Без режима auto старый XKeen ждёт ответов в меню, а их неоткуда взять
    if ! grep -q 'get_auto_arg' "$XKEEN_BIN"; then
      printf "${ERROR} Установленная версия XKeen не поддерживает автоустановку.${NC}\n"
      printf " Обновите XKeen командой ${GREEN_BOLD}xkeen -uk${NC} и запустите эту команду снова.\n\n"
      exit 1
    fi
    printf "${INFO} XKeen уже установлен, ставим ядро Xray...${NCN}"
    "$XKEEN_BIN" -ux auto < /dev/null
  else
    printf " XKeen и Xray уже установлены, пропускаем\n"
  fi
  if [ ! -x "$XKEEN_BIN" ] || [ ! -x "$XRAY_BIN" ]; then
    printf "${ERROR} XKeen или ядро Xray не установлены, установка панели прервана.${NCN}"
    exit 1
  fi
  switch_to_xray

  if [ -f "$XKEENUI_BIN" ]; then
    update_xkeenui
  else
    install_xkeenui
  fi
}

get_status() {
  [ ! -f "$XKEENUI_BIN" ] && printf "Статус панели: ${RED_BOLD}не установлена${NC}" && return

  local version=$($XKEENUI_BIN -v 2>/dev/null | awk 'NR==1{print $3}')
  local status="${RED_BOLD}не запущена"

  version=${version:-"N/A"}

  pidof xkeen-ui &>/dev/null && status="${GREEN_BOLD}запущена"
  printf "Статус панели: $status ${NC}[$version]"
}

get_arch

if [ "$AUTO" = true ]; then
  auto_setup
  exit 0
fi

clear
printf "${CYAN}"
cat <<'EOF'
   _  __  __ __                       __  __ ____
  | |/ / / //_/___   ___   ____      / / / //  _/
  |   / / ,<  / _ \ / _ \ / __ \    / / / / / /
 /   | / /| |/  __//  __// / / /   / /_/ /_/ /
/_/|_|/_/ |_|\___/ \___//_/ /_/    \____//___/
EOF

printf "${NC}\n$(get_status)\n"
printf "Архитектура: ${GREEN_BOLD}$ARCH\n"
printf "\nДобро пожаловать! Выберите действие:${NCN}"
printf "  1. Установить/переустановить\n"
printf "  2. Обновить\n"
printf "  3. Удалить\n"
printf "\n  0. Выйти\n\n"

read -p "${GREEN_BOLD}>: ${NC}" response < /dev/tty

case $response in
  1) install_xkeenui;;
  2) update_xkeenui;;
  3) uninstall_xkeenui;;
  0) echo; exit;;
  *) printf "${ERROR} Неверный выбор.${NCN}"; exit 1;;
esac
