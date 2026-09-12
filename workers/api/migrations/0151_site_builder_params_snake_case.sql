-- Site Builder's three subscriber settings reach its pipelines (#805).
--
-- 0057 seeded the agent with a settings card whose ids are snake_case (`mcp_url`,
-- `template_slug`, `photo_limit`) and two pipeline definitions whose params were camelCase
-- (`mcpUrl`, `templateSlug`, `photoLimit`). A setting addresses a param BY NAME, exactly
-- (`paramsWithDefaults`, lib/instance-settings.ts), so all three settings landed in the run's
-- params as inert extras and every `{"$param":"mcpUrl"}` resolved to undefined. `mcp_url` is the
-- one setting the agent cannot work without — no builder is hardcoded, the endpoint IS the
-- setting — so the console rendered a card the subscriber could fill in and the run could never
-- see. #394's fix commit named this in passing and changed nothing; this is the change.
--
-- The PARAMS are renamed, not the settings: stored values in `agent_instances.config.settings`
-- are keyed by setting id, and renaming those would orphan every value a subscriber has entered.
-- snake_case is also the house style — `place_id` in these same definitions, `max_places` on the
-- Lead Finder (0111) — so the three were the outliers in their own file.
--
-- ── Why a new migration, and why it carries the definitions
--
-- 0057 has already run in production (and is grandfathered in scripts/check-migrations.mjs), so
-- editing it changes nothing live. The two literals below are generated from
-- lib/pipelines/site-builder.json and site-deploy.json — the reference the runner tests drive —
-- and `seed-drift.test.ts` pairs them against this file, so this is the seed copy, and 0057's
-- is the historical one (that test also asserts 0057's copy differs from the reference ONLY in
-- the three param names, so the whole change is visible from one place).
--
-- ── The instance copies (#496)
--
-- `$.pipelines` is an instance-copied key (lib/instance-copied-config.ts): subscribe copies it
-- once and `loadPipeline` reads `agent_instances.config` with no fallback, so the first
-- statement fixes the catalog and reaches nobody already running the agent. The second and
-- third reach them, one pipeline each, in 0130's shape:
--
--   * Gated on the STALE shape — the instance copy still declares `params.mcpUrl`. The fixed
--     definition has no such key, so a copy that has been replaced (or hand-fixed) never matches
--     again: idempotent, and it cannot overwrite the archive with the value it just wrote.
--   * The old copy is archived verbatim under `$.pipelinesReplaced.<key>` so nothing is
--     destroyed; a subscriber's hand edit inside a stale copy can be re-applied from there.
--     `$.pipelinesReplaced` is inert — nothing reads it.
--   * Copied FROM the agents row rather than embedded a second time in this file, so there is
--     no third copy to drift.
--
-- ── Fails closed
--
-- Every read is normalised through `CASE WHEN json_valid(config) …` so a malformed row cannot
-- error the migration and take a deploy with it. On a fresh database, or one where 0057 never
-- applied, the slug matches no row and all three statements are clean no-ops.

UPDATE agents
   SET config = json_set(
         -- Ensure the parent exists: json_set creates a LEAF, never an intermediate object.
         json_set(
           CASE WHEN json_valid(config) THEN config ELSE '{}' END,
           '$.pipelines',
           json(COALESCE(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines'), '{}'))
         ),
         '$.pipelines.site-builder', json('{
  "name": "site-builder",
  "params": {
    "place_id": {
      "type": "string",
      "description": "Google Places id of the lead — the one required input; everything else is looked up."
    },
    "mcp_url": {
      "type": "string",
      "description": "Website-builder MCP endpoint. Per-instance config: no server is hardcoded in the platform."
    },
    "template_slug": {
      "type": "string",
      "description": "Designer template to build from, e.g. \"neon-ai\"."
    },
    "photo_limit": {
      "type": "number",
      "description": "How many venue photos to pull into the gallery (default 4)."
    }
  },
  "steps": [
    {
      "tool": "http_request",
      "bind": "details",
      "inputs": {
        "method": "GET",
        "url": "https://places.googleapis.com/v1/places/{{place_id}}",
        "inputs": {
          "place_id": {
            "$param": "place_id"
          }
        },
        "headers": {
          "X-Goog-FieldMask": "id,displayName,formattedAddress,shortFormattedAddress,nationalPhoneNumber,websiteUri,googleMapsUri,rating,userRatingCount,editorialSummary,regularOpeningHours,primaryTypeDisplayName,photos,addressComponents"
        },
        "auth": {
          "mode": "api-key",
          "key": {
            "in": "header",
            "name": "X-Goog-Api-Key"
          }
        }
      }
    },
    {
      "tool": "slice",
      "bind": "shots",
      "inputs": {
        "items": {
          "$ref": "details.data.photos"
        },
        "limit": {
          "$param": "photo_limit"
        }
      }
    },
    {
      "tool": "http_request",
      "bind": "photoPages",
      "forEach": {
        "$ref": "shots.items"
      },
      "inputs": {
        "method": "GET",
        "url": "https://places.googleapis.com/v1/{{photo}}/media",
        "inputs": {
          "photo": {
            "$param": "item.name"
          }
        },
        "query": {
          "maxWidthPx": 1200,
          "skipHttpRedirect": "true"
        },
        "auth": {
          "mode": "api-key",
          "key": {
            "in": "query",
            "name": "key"
          }
        },
        "responseMap": "photoUri"
      }
    },
    {
      "tool": "flatten",
      "bind": "photos",
      "inputs": {
        "items": {
          "$ref": "photoPages"
        },
        "path": "data"
      }
    },
    {
      "tool": "map",
      "bind": "base",
      "inputs": {
        "items": [
          {
            "d": {
              "$ref": "details.data"
            },
            "place_id": {
              "$param": "place_id"
            }
          }
        ],
        "extract": {
          "name": "d.displayName.text",
          "address": "d.formattedAddress",
          "short_address": "d.shortFormattedAddress",
          "phone": "d.nationalPhoneNumber",
          "maps_url": "d.googleMapsUri",
          "rating": "d.rating",
          "reviews_count": "d.userRatingCount",
          "blurb": "d.editorialSummary.text",
          "hours": "d.regularOpeningHours.weekdayDescriptions",
          "kind": "d.primaryTypeDisplayName.text",
          "suburb": "d.addressComponents[types~=locality].longText",
          "state": "d.addressComponents[types~=administrative_area_level_1].longText"
        },
        "keep": [
          "place_id"
        ],
        "derive": {
          "search_query": {
            "$format": "{{name}} {{suburb}} instagram facebook"
          },
          "ticket_title": {
            "$format": "Deploy the site for {{name}}"
          }
        }
      }
    },
    {
      "tool": "web_search",
      "bind": "hits",
      "inputs": {
        "query": {
          "$ref": "base.items.0.search_query"
        },
        "num": 8
      }
    },
    {
      "tool": "extract_contacts",
      "bind": "contacts",
      "inputs": {
        "items": {
          "$ref": "hits"
        }
      }
    },
    {
      "tool": "map",
      "bind": "biz",
      "inputs": {
        "items": [
          {
            "b": {
              "$ref": "base.items.0"
            },
            "c": {
              "$ref": "contacts"
            },
            "photo_urls": {
              "$ref": "photos.items"
            }
          }
        ],
        "extract": {
          "place_id": "b.place_id",
          "name": "b.name",
          "address": "b.address",
          "short_address": "b.short_address",
          "phone": "b.phone",
          "maps_url": "b.maps_url",
          "rating": "b.rating",
          "reviews_count": "b.reviews_count",
          "blurb": "b.blurb",
          "hours": "b.hours",
          "kind": "b.kind",
          "suburb": "b.suburb",
          "state": "b.state",
          "ticket_title": "b.ticket_title",
          "instagram": "c.instagram",
          "facebook": "c.facebook",
          "email": "c.email"
        },
        "keep": [
          "photo_urls"
        ]
      }
    },
    {
      "tool": "ai_generate",
      "bind": "drafted",
      "inputs": {
        "items": {
          "$ref": "biz.items"
        },
        "system": "You write short, plain, honest copy for a small local business''s first website. You are given ONLY facts scraped from Google Maps and public social profiles. Never invent a fact: no awards, no founding year, no staff names, no claims about quality, price or history you were not given. If you have little to work with, write less. Australian/British spelling. No emoji, no exclamation marks, no ''nestled in the heart of''. Reply with ONLY a JSON object — no prose, no code fence.",
        "prompt": "Business facts:\n- Name: {{name}}\n- Type: {{kind}}\n- Address: {{address}}\n- Suburb: {{suburb}}, {{state}}\n- Phone: {{phone}}\n- Google rating: {{rating}} from {{reviews_count}} reviews\n- Google''s own summary: {{blurb}}\n- Opening hours: {{hours}}\n- Photo URLs (comma-separated, may be empty): {{photo_urls}}\n\nReturn JSON with exactly these keys:\n{\n  \"tagline\": \"6-10 words for the hero. What they are and where.\",\n  \"meta_description\": \"One sentence under 155 characters for search results.\",\n  \"about_html\": \"2-3 short sentences as HTML paragraphs. Only what the facts above support.\",\n  \"services_html\": \"A <ul> of 3-5 short items a customer would come here for, inferred from the business TYPE alone.\",\n  \"gallery_html\": \"For each photo URL above, one <img src=\\\"THE URL VERBATIM\\\" alt=\\\"...\\\" loading=\\\"lazy\\\"> wrapped in a <div class=\\\"grid\\\">. Copy each URL character-for-character; never shorten or invent one. Empty string if there are no photo URLs.\",\n  \"hours_line\": \"The opening hours as one readable line, or \\\"\\\" if unknown.\",\n  \"category\": \"one of: restaurant, cafe, salon, trades, retail, fitness, professional, health, education, creative, other\",\n  \"slug\": \"The business name as a URL slug: lowercase letters, numbers and hyphens ONLY, no leading/trailing hyphen, 3-40 characters. Add the suburb if the name alone is generic.\"\n}",
        "as": "copy_json",
        "maxTokens": 900
      }
    },
    {
      "tool": "parse_json",
      "bind": "copy",
      "inputs": {
        "items": {
          "$ref": "drafted.items"
        },
        "field": "copy_json",
        "as": "copy"
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "site",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "create_site",
        "args": {
          "template_slug": {
            "$param": "template_slug"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "meta",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "set_meta",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "title": {
            "$ref": "copy.items.0.name"
          },
          "description": {
            "$ref": "copy.items.0.copy.meta_description"
          },
          "noindex": true
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "contact",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "set_contact",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "phone": {
            "$ref": "copy.items.0.phone"
          },
          "email": {
            "$ref": "copy.items.0.email"
          },
          "address": {
            "$ref": "copy.items.0.address"
          },
          "hours": {
            "$ref": "copy.items.0.copy.hours_line"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "social",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "set_social",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "instagram": {
            "$ref": "copy.items.0.instagram"
          },
          "facebook": {
            "$ref": "copy.items.0.facebook"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "aboutSection",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "add_section",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "type": "about",
          "label": "About",
          "content": {
            "$ref": "copy.items.0.copy.about_html"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "servicesSection",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "add_section",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "type": "features",
          "label": "What we do",
          "content": {
            "$ref": "copy.items.0.copy.services_html"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "gallerySection",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "add_section",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "type": "gallery",
          "label": "Gallery",
          "content": {
            "$ref": "copy.items.0.copy.gallery_html"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "preview",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "get_preview",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          }
        }
      }
    },
    {
      "tool": "create_ticket",
      "bind": "gate",
      "inputs": {
        "title": {
          "$ref": "copy.items.0.ticket_title"
        },
        "reasoning": "Built from this business''s Google Maps listing and public social profiles. Nothing is live: the draft is set to noindex and no domain is claimed. Approving deploys it. The copy is written from scraped facts, so read the preview first — especially anything that reads as a claim about the business.",
        "action": "run_pipeline",
        "config": {
          "pipeline": "site-deploy"
        },
        "params": {
          "place_id": {
            "$param": "place_id"
          },
          "mcp_url": {
            "$param": "mcp_url"
          },
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "name": {
            "$ref": "copy.items.0.name"
          },
          "slug": {
            "$ref": "copy.items.0.copy.slug"
          },
          "category": {
            "$ref": "copy.items.0.copy.category"
          },
          "description": {
            "$ref": "copy.items.0.copy.meta_description"
          },
          "suburb": {
            "$ref": "copy.items.0.suburb"
          },
          "address": {
            "$ref": "copy.items.0.address"
          },
          "phone": {
            "$ref": "copy.items.0.phone"
          },
          "email": {
            "$ref": "copy.items.0.email"
          }
        }
      }
    },
    {
      "tool": "map",
      "bind": "record",
      "inputs": {
        "items": {
          "$ref": "copy.items"
        },
        "keep": [
          "place_id",
          "name",
          "address",
          "phone",
          "maps_url",
          "suburb",
          "state",
          "instagram",
          "facebook",
          "email",
          "photo_urls"
        ],
        "derive": {
          "site_status": "awaiting_approval",
          "site_session_id": {
            "$ref": "site.data.session_id"
          }
        }
      }
    },
    {
      "tool": "dedupe_upsert",
      "bind": "stored",
      "inputs": {
        "items": {
          "$ref": "record.items"
        },
        "collection": "sites",
        "key": "place_id",
        "mode": "update",
        "emit": "site.drafted"
      }
    }
  ],
  "sink": {
    "collection": "sites",
    "keyField": "place_id"
  }
}'),
         '$.pipelines.site-deploy', json('{
  "name": "site-deploy",
  "params": {
    "session_id": {
      "type": "string",
      "description": "Builder session from site-builder''s create_site — what actually gets deployed."
    },
    "place_id": {
      "type": "string",
      "description": "Google Places id, so the outcome lands back on the right lead."
    },
    "mcp_url": {
      "type": "string",
      "description": "Website-builder MCP endpoint (same one site-builder used)."
    },
    "slug": {
      "type": "string",
      "description": "Site slug — lowercase letters, numbers, hyphens."
    },
    "name": {
      "type": "string",
      "description": "Business display name."
    },
    "category": {
      "type": "string",
      "description": "Site category chosen by the copy step."
    },
    "description": {
      "type": "string",
      "description": "One-sentence site description."
    },
    "suburb": {
      "type": "string",
      "description": "Suburb, carried through for the outreach pitch."
    },
    "address": {
      "type": "string",
      "description": "Street address, carried through for the outreach pitch."
    },
    "phone": {
      "type": "string",
      "description": "Phone, carried through for the outreach pitch."
    },
    "email": {
      "type": "string",
      "description": "Public email if one was found, carried through for the outreach pitch."
    }
  },
  "steps": [
    {
      "tool": "mcp_call_tool",
      "bind": "deployed",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "deploy",
        "args": {
          "session_id": {
            "$param": "session_id"
          },
          "id": {
            "$param": "slug"
          },
          "name": {
            "$param": "name"
          },
          "category": {
            "$param": "category"
          },
          "description": {
            "$param": "description"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "status",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "get_status",
        "args": {
          "session_id": {
            "$param": "session_id"
          }
        }
      }
    },
    {
      "tool": "map",
      "bind": "record",
      "inputs": {
        "items": [
          {
            "s": {
              "$ref": "status.data"
            },
            "place_id": {
              "$param": "place_id"
            },
            "name": {
              "$param": "name"
            },
            "suburb": {
              "$param": "suburb"
            },
            "address": {
              "$param": "address"
            },
            "phone": {
              "$param": "phone"
            },
            "email": {
              "$param": "email"
            }
          }
        ],
        "extract": {
          "site_url": "s.url",
          "site_slug": "s.id"
        },
        "keep": [
          "place_id",
          "name",
          "suburb",
          "address",
          "phone",
          "email"
        ],
        "derive": {
          "site_status": "live"
        }
      }
    },
    {
      "tool": "dedupe_upsert",
      "bind": "stored",
      "inputs": {
        "items": {
          "$ref": "record.items"
        },
        "collection": "sites",
        "key": "place_id",
        "mode": "update",
        "emit": "site.live",
        "emitOn": "both"
      }
    }
  ],
  "sink": {
    "collection": "sites",
    "keyField": "place_id"
  }
}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'site-builder';

UPDATE agent_instances
   SET config = json_set(
         json_set(
           -- Ensure `$.pipelinesReplaced` exists first: json_set creates a LEAF, never an
           -- intermediate object, so writing the archive into a config without the parent would
           -- be a silent no-op and the old copy would be lost.
           json_set(
             CASE WHEN json_valid(config) THEN config ELSE '{}' END,
             '$.pipelinesReplaced',
             json(COALESCE(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelinesReplaced'), '{}'))
           ),
           '$.pipelinesReplaced.site-builder',
           json(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.site-builder'))
         ),
         -- Narrow path: every other pipeline on the instance, the display name, the runner-node
         -- pin and the stored settings all survive untouched.
         '$.pipelines.site-builder',
         json((SELECT json_extract(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.site-builder')
                 FROM agents a
                WHERE a.slug = 'site-builder'))
       ),
       updated_at = datetime('now')
 WHERE agent_id IN (SELECT a.id FROM agents a WHERE a.slug = 'site-builder')
   AND json_type(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.site-builder.params.mcpUrl') IS NOT NULL
   AND (SELECT json_type(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.site-builder.params.mcp_url')
          FROM agents a
         WHERE a.slug = 'site-builder') = 'object';

UPDATE agent_instances
   SET config = json_set(
         json_set(
           -- Ensure `$.pipelinesReplaced` exists first: json_set creates a LEAF, never an
           -- intermediate object, so writing the archive into a config without the parent would
           -- be a silent no-op and the old copy would be lost.
           json_set(
             CASE WHEN json_valid(config) THEN config ELSE '{}' END,
             '$.pipelinesReplaced',
             json(COALESCE(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelinesReplaced'), '{}'))
           ),
           '$.pipelinesReplaced.site-deploy',
           json(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.site-deploy'))
         ),
         -- Narrow path: every other pipeline on the instance, the display name, the runner-node
         -- pin and the stored settings all survive untouched.
         '$.pipelines.site-deploy',
         json((SELECT json_extract(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.site-deploy')
                 FROM agents a
                WHERE a.slug = 'site-builder'))
       ),
       updated_at = datetime('now')
 WHERE agent_id IN (SELECT a.id FROM agents a WHERE a.slug = 'site-builder')
   AND json_type(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.site-deploy.params.mcpUrl') IS NOT NULL
   AND (SELECT json_type(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.site-deploy.params.mcp_url')
          FROM agents a
         WHERE a.slug = 'site-builder') = 'object';
