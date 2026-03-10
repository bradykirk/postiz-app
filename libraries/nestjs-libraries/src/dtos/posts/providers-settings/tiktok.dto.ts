import {
  IsBoolean, ValidateIf, IsIn, IsString, MaxLength, IsOptional
} from 'class-validator';

export class TikTokDto {
  @ValidateIf((p) => p.title)
  @MaxLength(90)
  title: string;

  @ValidateIf((o) => o.content_posting_method === 'DIRECT_POST')
  @IsIn([
    'PUBLIC_TO_EVERYONE',
    'MUTUAL_FOLLOW_FRIENDS',
    'FOLLOWER_OF_CREATOR',
    'SELF_ONLY',
  ])
  @IsString()
  privacy_level:
    | 'PUBLIC_TO_EVERYONE'
    | 'MUTUAL_FOLLOW_FRIENDS'
    | 'FOLLOWER_OF_CREATOR'
    | 'SELF_ONLY';

  @ValidateIf((o) => o.content_posting_method === 'DIRECT_POST')
  @IsBoolean()
  duet: boolean;

  @ValidateIf((o) => o.content_posting_method === 'DIRECT_POST')
  @IsBoolean()
  stitch: boolean;

  @ValidateIf((o) => o.content_posting_method === 'DIRECT_POST')
  @IsBoolean()
  comment: boolean;

  @IsIn(['yes', 'no'])
  autoAddMusic: 'yes' | 'no';

  @ValidateIf((o) => o.content_posting_method === 'DIRECT_POST')
  @IsBoolean()
  brand_content_toggle: boolean;

  @IsBoolean()
  @IsOptional()
  video_made_with_ai: boolean;

  @ValidateIf((o) => o.content_posting_method === 'DIRECT_POST')
  @IsBoolean()
  disclose: boolean;

  @ValidateIf((o) => o.content_posting_method === 'DIRECT_POST')
  @IsBoolean()
  brand_organic_toggle: boolean;

  @IsIn(['DIRECT_POST', 'UPLOAD'])
  @IsString()
  content_posting_method: 'DIRECT_POST' | 'UPLOAD';

  @IsBoolean()
  consent: boolean;
}
