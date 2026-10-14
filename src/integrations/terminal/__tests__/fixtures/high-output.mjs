const chunk = Buffer.from("界🙂\r\n".repeat(8192))
for (let index = 0; index < 32; index++) process.stdout.write(chunk)
process.stdout.write("final-no-newline🙂")
import { Buffer } from "node:buffer"
import process from "node:process"
