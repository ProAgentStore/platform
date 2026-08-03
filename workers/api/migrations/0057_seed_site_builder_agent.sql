-- Register the first-party "Small Business Website Builder" agent — the third link in the
-- lead chain (Lead Finder → Lead Outreach → this).
--
-- What it does: takes a lead that has NO website, reads that business's public Google Maps
-- listing (details, opening hours, rating, photos) plus its public social profiles, drafts
-- honest copy from those facts with the owner's own BYOK model, and builds a one-page site
-- through a website-builder MCP server the owner configures. It stops there: the site is
-- built as an unindexed draft and a board ticket asks the owner to approve the deploy.
--
-- Runner-less and cloud-only (runtime:null, workflow:null). Every step is a DECLARATIVE
-- pipeline (lib/pipelines/site-builder.json + site-deploy.json) — no bespoke Worker — and
-- the two pipelines are seeded into config.pipelines so a fresh subscription works after
-- only filling in the two settings below.
--
-- Nothing here names a specific website builder. `mcp_url` is a per-subscriber setting, so
-- the platform keeps no runtime dependency on any particular service.

INSERT OR IGNORE INTO users (id, github_login, github_name, avatar_url, roles)
VALUES ('system', 'proagentstore', 'ProAgentStore', '', '["user","creator","admin"]');

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_site_builder',
  'system',
  'site-builder',
  'Small Business Website Builder',
  'Builds a business its first website. Point it at a lead with no website and it reads that business''s public Google Maps listing — details, hours, rating, photos — plus its social profiles, writes honest copy from those facts, and assembles a one-page site through your website-builder MCP server. Nothing goes live: it hands you an unindexed draft and asks before deploying.',
  'Sales',
  'agent',
  '🏗️',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  json('{
  "capabilities": {
    "surfaces": [],
    "runtime": null,
    "workflow": null
  },
  "settingsSchema": [
    {
      "id": "mcp_url",
      "label": "Website-builder MCP endpoint",
      "type": "text",
      "description": "The Streamable-HTTP MCP server that builds the sites, e.g. https://agent.example.com/mcp. Store its access token under the \"mcp\" provider in Profile → API keys.",
      "default": ""
    },
    {
      "id": "template_slug",
      "label": "Designer template",
      "type": "text",
      "description": "Which template new sites start from. Ask the builder for its template list; leave blank to let it choose.",
      "default": ""
    },
    {
      "id": "photo_limit",
      "label": "Photos per site",
      "type": "number",
      "description": "How many photos from the Google listing to pull into the gallery.",
      "default": 4
    }
  ],
  "identity": {
    "personality": "You build first websites for small local businesses that do not have one. You work only from what is publicly verifiable about a business — its Google Maps listing and its public social profiles — and you never invent facts about someone else''s business: no awards, no founding dates, no staff names, no claims about quality or price. When you do not know something, you leave it out rather than filling it in.",
    "goal": "Turn a no-website lead into a ready-to-show draft site built from that business''s real public details, and get the owner''s approval before anything goes live.",
    "guardrails": {
      "responseStyle": "plain",
      "topicRestrictions": "",
      "blockedTerms": [],
      "maxResponseLength": 0,
      "requireCitations": false
    },
    "welcomeMessage": "Give me a lead — a Google Places id, or one from your Lead Finder — and I will read that business''s public listing and socials, draft a site from what is actually there, and put it on your board for approval. Nothing goes live until you say so."
  },
  "pipelines": {
    "site-builder": {
      "name": "site-builder",
      "params": {
        "place_id": {
          "type": "string",
          "description": "Google Places id of the lead — the one required input; everything else is looked up."
        },
        "mcpUrl": {
          "type": "string",
          "description": "Website-builder MCP endpoint. Per-instance config: no server is hardcoded in the platform."
        },
        "templateSlug": {
          "type": "string",
          "description": "Designer template to build from, e.g. \"neon-ai\"."
        },
        "photoLimit": {
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
              "$param": "photoLimit"
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
              "$param": "mcpUrl"
            },
            "tool": "create_site",
            "args": {
              "template_slug": {
                "$param": "templateSlug"
              }
            }
          }
        },
        {
          "tool": "mcp_call_tool",
          "bind": "meta",
          "inputs": {
            "url": {
              "$param": "mcpUrl"
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
              "$param": "mcpUrl"
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
              "$param": "mcpUrl"
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
              "$param": "mcpUrl"
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
              "$param": "mcpUrl"
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
              "$param": "mcpUrl"
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
              "$param": "mcpUrl"
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
              "mcpUrl": {
                "$param": "mcpUrl"
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
    },
    "site-deploy": {
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
        "mcpUrl": {
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
              "$param": "mcpUrl"
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
              "$param": "mcpUrl"
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
    }
  }
}'),
  datetime('now'),
  datetime('now')
);
