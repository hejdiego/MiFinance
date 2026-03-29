# Gastos → Notion

Gestor de gastos personal que registra directamente en tu base de datos de Notion. Funciona desde el navegador, como PWA en iOS, y se puede activar desde iOS Shortcuts.

---

## Deploy en Railway (recomendado)

1. Sube este proyecto a un repo en GitHub
2. Ve a [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Selecciona el repo, Railway detecta Node automáticamente
4. El servidor queda en `https://tu-proyecto.up.railway.app`

## Deploy en Render

1. Sube a GitHub
2. [render.com](https://render.com) → New Web Service → conecta repo
3. Build: `npm install` · Start: `node server.js`

---

## Configuración inicial

1. Abre la URL de tu app
2. Ingresa tu **Notion Integration Token** (`secret_xxx`) — créalo en [notion.so/my-integrations](https://notion.so/my-integrations)
3. Ingresa el **Database ID** de "My Money" (los 32 caracteres en la URL de la base)
4. Asegúrate de haber compartido la base con la integración en Notion
5. Mapea cada campo de la app con la propiedad correspondiente de tu base
6. ¡Listo!

---

## iOS Shortcut — registro ultrarrápido

### Pasos en la app Atajos (Shortcuts):

1. **Nuevo atajo** → busca la acción `Pedir entrada`
   - Campo 1: "Monto" (tipo Número)
   - Campo 2: "Descripción" (tipo Texto)
   - Campo 3: "Categoría" (tipo Texto, con opciones predefinidas)
   - Campo 4: "Cuenta" (tipo Texto, con opciones predefinidas)

2. Agrega acción `URL` con:
   ```
   https://tu-dominio.com/api/expense
   ```

3. Agrega acción `Obtener contenido de URL`:
   - Método: **POST**
   - Cuerpo: **JSON**
   - Campos:
     ```
     token        → tu_integration_token
     databaseId   → tu_database_id
     mapping      → {"name":"Nombre","amount":"Monto","category":"Categoría","date":"Fecha","account":"Cuenta","tags":"Etiquetas"}
     expense      → {"name": [Descripción], "amount": [Monto], "category": [Categoría], "account": [Cuenta], "date": [Fecha actual]}
     ```

4. Agrega acción `Mostrar resultado` para confirmar el registro

5. Guarda el atajo y agrégalo a la pantalla de inicio

### Activar con Siri:
"Oye Siri, registrar gasto"

---

## Estructura del proyecto

```
app/
├── server.js          # Backend Express + proxy a Notion API
├── package.json
├── Procfile           # Para Railway/Heroku
└── public/
    └── index.html     # Frontend completo (SPA)
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/validate` | Valida token + DB y retorna schema |
| POST | `/api/expense` | Crea un gasto en Notion |
| POST | `/api/expenses` | Trae los últimos 100 gastos |

---

## Variables de entorno

No se requieren variables de entorno. Las credenciales de Notion se pasan en cada request desde el frontend (guardadas en localStorage del dispositivo).
