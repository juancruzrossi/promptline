#!/bin/bash
# prompt-queue.sh
# Cola de prompts para Claude Code.
# Lee el siguiente prompt de un archivo, lo envia por stderr y sale con exit 2
# para que Claude siga trabajando como si el usuario hubiese escrito ese prompt.
# Si no hay mas prompts, sale con exit 0 y Claude se detiene normalmente.

set -euo pipefail

# --- Leer input JSON del hook desde stdin ---
INPUT=$(cat)

# Ruta fija al archivo de prompts (independiente del proyecto actual)
PROMPTS_FILE="${PROMPTS_FILE:-/Users/juanchirossi/Documents/Proyectos/prompts.txt}"

# --- Validaciones rapidas ---

# No existe el archivo -> salir
if [ ! -f "$PROMPTS_FILE" ]; then
    exit 0
fi

# Archivo vacio -> salir
if [ ! -s "$PROMPTS_FILE" ]; then
    exit 0
fi

# Solo whitespace -> limpiar y salir
if ! grep -qE '[^[:space:]]' "$PROMPTS_FILE"; then
    : > "$PROMPTS_FILE"
    exit 0
fi

# --- Extraer primer prompt (todo antes del primer ---) ---
first_prompt=$(awk '/^---[[:space:]]*$/{exit} {print}' "$PROMPTS_FILE")

# --- Extraer contenido restante (todo despues del primer ---) ---
remaining=$(awk 'BEGIN{f=0} /^---[[:space:]]*$/{if(!f){f=1;next}} f{print}' "$PROMPTS_FILE")

# --- Verificar que el prompt tenga contenido real ---
if ! echo "$first_prompt" | grep -qE '[^[:space:]]'; then
    : > "$PROMPTS_FILE"
    exit 0
fi

# --- Escribir prompts restantes de vuelta al archivo ---
printf '%s\n' "$remaining" > "$PROMPTS_FILE"

# Si no quedan prompts significativos, limpiar el archivo
if ! grep -qE '[^[:space:]]' "$PROMPTS_FILE"; then
    : > "$PROMPTS_FILE"
fi

# --- Contar prompts restantes ---
if [ -s "$PROMPTS_FILE" ] && grep -qE '[^[:space:]]' "$PROMPTS_FILE"; then
    separator_count=$(grep -c '^---[[:space:]]*$' "$PROMPTS_FILE" 2>/dev/null || true)
    remaining_count=$((separator_count + 1))
else
    remaining_count=0
fi

# --- Enviar prompt por stderr y bloquear el stop ---
{
    echo "===== PromptLine: Ejecutando siguiente prompt (quedan ${remaining_count} en cola) ====="
    echo ""
    echo "$first_prompt"
} >&2

exit 2
