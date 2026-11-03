# Regla de Formato de Fecha

## Formato Europeo Obligatorio
El formato de fecha en todo el proyecto debe ser obligatoriamente el europeo:
- **Fechas**: `dd/mm/aaaa` (por ejemplo: `01/10/2026`).
- **Fechas con hora**: `dd/mm/aaaa HH:mm:ss` (por ejemplo: `01/10/2026 18:30:00`).

## Directrices Técnicas
- **Utilizar `src/utils.ts`**: Utilizar siempre las funciones auxiliares `formatDate()` y `formatDateTime()` exportadas en `src/utils.ts`.
- **Prohibido**: No utilizar `new Date().toLocaleDateString()` o `new Date().toLocaleString()` sin parámetros, ya que por defecto en entornos Node.js / Linux pueden generar fechas en formato anglosajón (`m/d/yyyy`).
- **Alcance**: Se aplica a todas las interfaces HTML generadas (chips en cabeceras de cursos, metadatos de comunidades, índices), mensajes del CLI en consola y logs dirigidos al usuario.
