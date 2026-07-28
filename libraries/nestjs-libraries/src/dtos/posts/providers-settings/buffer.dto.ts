import { IsBoolean, IsOptional } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

export class BufferDto {
  @IsBoolean()
  @IsOptional()
  @JSONSchema({
    description: 'Discloses that the post contains AI-generated content',
  })
  made_with_ai: boolean;
}
