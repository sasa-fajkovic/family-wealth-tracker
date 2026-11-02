import { HTTPException } from 'hono/http-exception'
import { ValidationError } from '../models/validation.js'

export function validationException(error: unknown, prefix: string): HTTPException {
  const message = `${prefix}: ${(error as Error).message}`
  const issues = error instanceof ValidationError ? error.issues : [{ field: 'file', message: (error as Error).message }]
  return new HTTPException(400, { message, res: Response.json({ error: message, issues }, { status: 400 }) })
}
